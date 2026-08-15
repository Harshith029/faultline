# Operating the FAULTLINE agent

The agent is a long-running process that collects telemetry on an interval,
scores cascade risk, manages incidents, and exposes an HTTP API. It has zero
runtime dependencies and holds no state it cannot rebuild except its incident
history.

## Lifecycle of one tick

```
source.collect()
  → normalize samples            (missing/NaN metrics coerce to 0, never throw)
  → append to per-service ring buffer (capacity = detector.historyWindows)
  → runDetection() on the buffer (@faultline/core, the same engine the UI uses)
  → evaluate the newest window
  → AlertManager: open / update / resolve / suppress
  → notifiers + durable store
```

A tick that overruns its interval will not overlap with the next one; the
skipped cycle is logged as `agent.tick_skipped`.

## Warm-up

No service is evaluated until it has `baselineWindows + minSustain` samples.
Until then `/api/state` reports `status: "warming_up"` with `windowsRequired`.
At a 60s interval with the defaults, that is 12 minutes before the first
possible alert. This is deliberate: a baseline computed from three data points
is not a baseline.

## Rolling baseline

The baseline is the oldest `baselineWindows` entries in the buffer, so it
follows the service as its normal behaviour changes. The trade-off: an incident
that persists for longer than `historyWindows` ticks is eventually absorbed into
its own baseline and stops reading as drift.

Size the buffer for the longest incident you want to keep alerting on:

```
historyWindows × intervalSeconds  >  longest expected incident
```

Defaults (40 × 60s = 40 minutes) suit typical request-path services. For slow
burns — memory leaks, disk fill — raise `historyWindows` substantially.

## Choosing metrics

`detector.metrics` decides what the engine analyzes. The defaults —
`p99_latency`, `retry_rate`, `error_rate` — describe a request-path service, but
nothing in the engine is tied to them:

```json
"detector": {
  "metrics": ["queue_depth", "consumer_lag", "gc_pause_ms"],
  "minSignals": 2
}
```

Your source must emit a numeric field per metric name; missing or non-numeric
values coerce to 0 rather than throwing.

Two rules make a metric set work well:

1. **Pick signals that move for different reasons but fail together.** The
   detector's whole advantage is convergence, so metrics that are near-duplicates
   of one another (p95 and p99 latency) inflate the signal count without adding
   evidence. A saturation metric, a work-backlog metric, and an outcome metric is
   a strong trio.
2. **Every metric should be "higher is worse."** Detection is one-sided: only
   upward drift qualifies. If a metric fails by dropping — cache hit rate,
   throughput, success rate — invert it at the source (`100 - hit_rate`) so a
   degradation reads as an increase.

`minSignals` (default 2) is the convergence requirement and cannot exceed the
number of metrics configured. With a single metric you must set it to 1, which
turns FAULTLINE into a sustained-threshold detector and measurably increases
false positives.

## Per-service configuration

Real fleets are not homogeneous. A checkout API and a nightly batch worker
should not share a threshold, and `criticalityWeight` only means anything if it
can differ per service. The `services` block overrides any detector parameter
for the services a rule matches:

```json
"services": [
  { "match": "checkout-api", "name": "tier-1", "criticalityWeight": 3, "triggerThreshold": 2.5 },
  { "match": "queue-*", "name": "queues", "metrics": ["queue_depth", "consumer_lag"] },
  { "match": "batch-*", "name": "batch", "minSustain": 4, "triggerThreshold": 6 }
]
```

Anything unspecified falls through to the global `detector` config, so a rule
only states what differs.

**Matching order is deliberate.** An exact service name always beats a
wildcard, and among wildcards the first declared rule wins. Adding a broad `*`
catch-all can therefore never silently override a specific service configured
above it. Wildcards match only where placed: `api-*-eu` matches
`api-checkout-eu` but not `api-checkout-us`.

Overridable: `metrics`, `zThreshold`, `zThresholdPerMetric`, `minSustain`,
`minSignals`, `triggerThreshold`, `criticalityWeight`, `sigmaFloorRatio`,
`sigmaFloorAbs`, `baselineWindows`, `statistic`. Anything else is rejected at
startup — including `intervalSeconds`, which is agent-wide by nature.

`criticalityWeight` is the `W` in `R = mean_z × ln(1 + n) × W`. Raising it to 3
makes a tier-1 service cross the trigger on drift that a default service would
not, which is usually a better lever than lowering its threshold because it
scales the whole score rather than moving one cliff edge.

To confirm a rule is actually in effect, `GET /api/state` reports the matched
profile per service and `serviceProfiles` lists every compiled rule:

```json
{ "service": "checkout-api", "profile": "tier-1", "R_score": 4.2 }
```

A `profile` of `null` means no rule matched and the global config applies.

## Silences and maintenance windows

Nobody runs alerting that cannot be muted during a deploy. Silences suppress
notifications for matching services; **detection keeps running**, so the risk
score stays visible and the incident is still recorded for the postmortem. Only
the page is withheld.

Recurring windows live in config:

```json
"silences": [
  { "match": "batch-*", "name": "nightly-batch", "daily": { "start": "02:00", "end": "04:00" } },
  { "match": "reporting", "name": "weekend", "daily": { "start": "00:00", "end": "23:59" }, "days": [0, 6] }
]
```

Ad-hoc silences go through the API, because during an incident you cannot
restart the agent to mute it:

```bash
curl -X POST localhost:8787/api/silences \
  -H 'Content-Type: application/json' \
  -d '{"match":"checkout-*","until":"2026-03-05T14:00:00Z","reason":"deploy 42","createdBy":"harsh"}'

curl localhost:8787/api/silences?active=true
curl -X DELETE localhost:8787/api/silences/<id>
```

| Field | Meaning |
|---|---|
| `match` | Exact service name or glob. Required. |
| `from` / `until` | ISO bounds for a one-off window. |
| `daily` | `{ "start": "HH:MM", "end": "HH:MM" }`, recurring. Wraps past midnight. |
| `days` | Weekday filter, `0` = Sunday. |
| `reason` / `createdBy` | Free text, echoed in logs and the API. |

**All times are UTC**, deliberately: an agent that silently follows a server's
local timezone will eventually mute the wrong hours after a DST shift.

Runtime silences are persisted and survive restarts; expired ones are pruned
automatically. Config silences cannot be deleted through the API — they belong
to the file, so a `DELETE` on one returns 400 rather than a change that would
vanish on the next restart.

**A silence never loses an incident.** If one opens while a service is muted, it
is recorded but not sent. If it is *still firing* when the window ends, it is
announced then. A resolve notification is only sent if the corresponding open
was, so you are never told something recovered that you were never told broke.

Observability: `GET /api/state` reports `silencedBy` per service, and
`/metrics` exposes `faultline_service_silenced{service}` and
`faultline_silences_active`. Alerting on a silence that has been active far
longer than intended is a good habit.

## Tuning to your traffic

Start with the defaults and one week of observation, then adjust:

**Too many alerts** — raise `minSustain` from 2 to 3 first. On the benchmark
suite (`npm run benchmark`) that single change moves precision from 69.4% to
83.3% while recall stays at 100%, at a cost of roughly one window of extra
delay. It is the highest-value knob by a wide margin, because a blip lasting
exactly `minSustain` windows is otherwise indistinguishable from the start of a
real cascade. Raising `triggerThreshold` or `zThreshold` also works but blunts
sensitivity to genuine slow burns.

**Spiky channels distorting the baseline** — `statistic: "median_mad"` swaps
mean and standard deviation for median and MAD, which ordinary spikes barely
move. Be aware of what it does and does not buy: on the real-telemetry backtest
it produced no precision improvement once alert volume was held constant, so
treat it as an option for unusual data shapes rather than a fix for noisy
alerting. MAD yields larger z-scores, so raise `zThreshold` (roughly 2.0 → 3.0)
if you enable it, or the detector simply becomes more sensitive.

**A single metric shouldn't be able to page anyone** — that is enforced by
`minSignals` (default 2): an incident requires at least two qualified signals
regardless of how extreme one of them is. Set it to 1 only if you want
single-signal alerting, which measurably increases false positives.

**Alerts arrive too late** — lower `triggerThreshold` toward 2.5, or shorten
`intervalSeconds` for faster-moving services.

**Quiet or low-traffic services produce huge z-scores** — a near-zero variance
baseline makes any movement look enormous. Set `sigmaFloorAbs` to the smallest
change you would consider meaningful:

```json
"sigmaFloorAbs": { "p99_latency": 5, "retry_rate": 0.1, "error_rate": 0.1 }
```

This is the single most important setting for real deployments and the most
common source of false positives when omitted.

## Alert routing

`alerting.notifiers` is a list; all of them receive every event.

- `stdout` — structured log line. Pairs well with any log-based alerting.
- `webhook` — `POST` with `{ text, event, severity, agent, incident }`. The
  `text` field makes it directly compatible with Slack, Mattermost and Discord.
  Supply the URL via `urlEnv` (recommended) or `FAULTLINE_WEBHOOK_URL`.
- `file` — appends JSONL. Useful for shipping into a log pipeline.

Notifier failures are logged as `notify.failed` and never interrupt detection.

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness. `503` when collection is failing repeatedly. |
| `GET /api/ranking` | Services ordered by current risk, highest first. `?limit=` caps the list. |
| `GET /api/state` | Current risk, signals, and metrics per service. |
| `GET /api/incidents` | Incident history. Filters: `status`, `service`, `limit`. |
| `GET /api/incidents/:id` | One incident. |
| `GET /api/windows?service=` | Full engine output for charting. |
| `GET /metrics` | Prometheus exposition format. |
| `POST /api/inject?service=` | Inject a synthetic fault (synthetic source only). |
| `GET /api/silences` | List silences. `?active=true` for currently in force. |
| `POST /api/silences` | Create an ad-hoc silence. |
| `DELETE /api/silences/:id` | Remove a runtime silence (config ones return 400). |

### Authentication

The API defaults to open, which is fine on localhost and unacceptable anywhere
else — it can create silences and therefore suppress your alerting. Set a token
and it is enforced:

```bash
export FAULTLINE_API_TOKEN=$(openssl rand -hex 32)     # read + write
export FAULTLINE_READ_TOKEN=$(openssl rand -hex 32)    # optional, read only
```

```bash
curl -H "Authorization: Bearer $FAULTLINE_API_TOKEN" localhost:8787/api/state
curl -H "X-API-Key: $FAULTLINE_READ_TOKEN" localhost:8787/metrics
```

| Behaviour | Detail |
|---|---|
| No token configured | Everything open, and a `server.unauthenticated` warning is logged at startup |
| Full token | Required for writes: creating or deleting silences, injecting faults |
| Read-only token | Reads only. Used on a write route it returns **403**, not 401 — the identity is valid, the permission is not |
| `auth.allowAnonymousRead: true` | Reads open, writes still guarded. Convenient for Prometheus scraping on a trusted network |
| `GET /health` | **Always anonymous.** Load balancers and Kubernetes probes must reach it before any credential exists, and it exposes no telemetry |

Tokens are compared with a constant-time digest comparison, so neither their
value nor their length leaks through response timing. They may only be supplied
by environment variable: putting a literal `token` in the config file is a
startup error, because config files get committed.

### TLS

```json
"server": { "tls": { "certFile": "/etc/faultline/tls.crt", "keyFile": "/etc/faultline/tls.key" } }
```

If a certificate is configured but unreadable the agent **refuses to start**
rather than quietly falling back to plaintext — silently downgrading is how
tokens end up on the wire. Binding beyond `127.0.0.1` without TLS logs a
`server.plaintext` warning.

Terminating TLS at your ingress or service mesh instead is equally valid; the
built-in option exists so the agent can stand alone.

### Scraping FAULTLINE with Prometheus

```yaml
scrape_configs:
  - job_name: faultline
    static_configs:
      - targets: ['faultline:8787']
```

Exposed series: `faultline_up`, `faultline_ticks_total`,
`faultline_collect_errors_total`, `faultline_risk_score{service}`,
`faultline_qualified_signals{service}`, `faultline_service_firing{service}`,
`faultline_incidents_total`, `faultline_incidents_open`.

A useful meta-alert, since a monitoring agent that stops collecting is worse
than no agent:

```yaml
- alert: FaultlineNotCollecting
  expr: increase(faultline_ticks_total[5m]) == 0
  for: 5m
```

## Persistence and restarts

Incidents are written to `storage.path` as JSON, atomically (temp file +
rename) and debounced, so a crash mid-write cannot corrupt the file. History is
capped at `storage.maxIncidents`. On restart the file is reloaded; if it is
missing or unreadable the agent starts with an empty history rather than
failing to boot.

Detection state — the rolling buffers and the incident lifecycle — is persisted
too, because otherwise every restart costs a full warm-up. At default settings
that is twelve minutes with nothing watching, and a rolling deploy of the agent
itself would blind your monitoring exactly when you are changing something.
Worse, an incident in flight would re-open on the new process and page a second
time.

Restoring stale state would be its own hazard, so it is guarded by age:

| Setting | Default | Effect |
|---|---|---|
| `storage.restoreMaxAgeSeconds` | `900` | Resume only if the snapshot is newer than this. `0` disables resuming entirely. |
| `storage.snapshotEveryTicks` | `10` | How often state is written mid-run. A clean shutdown always writes. |

Telemetry from an hour ago describes a system that may no longer exist, so
anything older than the window is discarded and the agent warms up honestly
rather than scoring against a baseline it should not trust. Between periodic
snapshots a hard crash loses at most `snapshotEveryTicks` windows; `SIGTERM`
loses none.

Startup says which happened:

```
INFO  state.restored    ageSeconds=8 services=3 samples=180
INFO  state.warming_up  reason=stale
```

`GET /api/state` reports the same under `stateRestored`. Reasons are
`disabled`, `no_saved_state`, `stale` and `unreadable_timestamp` — a corrupt
snapshot never blocks startup.

## Deployment

**Docker**

```bash
docker compose up -d
docker compose logs -f faultline
```

Mount your config at `/app/agent/faultline.config.json` and pass secrets as
environment variables. The image runs as a non-root user and ships a
`HEALTHCHECK` that polls `/health`.

**systemd**

```ini
[Service]
ExecStart=/usr/bin/node /opt/faultline/packages/agent/bin/faultline.js start --config /etc/faultline/config.json
Environment=FAULTLINE_WEBHOOK_URL=https://hooks.slack.com/services/...
Restart=always
User=faultline
```

**Kubernetes** — a single-replica Deployment. Use `/health` for both liveness
and readiness. Do not scale beyond one replica per config: replicas keep
independent buffers and would alert independently. Shard by running separate
deployments with different `source` scopes instead.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `/health` returns 503 | 3+ consecutive collection failures | Check source reachability; `agent.collect_failed` logs carry the error |
| Services stuck `warming_up` | Fewer samples than required | Confirm the source returns a stable `service` label every tick |
| Warm-up after every restart | Snapshot older than the restore window | Raise `storage.restoreMaxAgeSeconds`, or check the state file is on a persistent volume |
| `agent.tick_skipped` | Collection is slower than the interval | Raise `intervalSeconds` or narrow the queries |
| Alerts on a quiet service | Baseline variance near zero | Set `sigmaFloorAbs` |
| Long incident self-resolves while still broken | Incident absorbed into its rolling baseline | Raise `historyWindows` |

## Security

- No secrets belong in the config file. Use `urlEnv` or `tokenEnv`; literal
  tokens in config are rejected at startup.
- Set `FAULTLINE_API_TOKEN` for anything beyond localhost, and enable TLS or
  terminate it at your ingress.
- The agent makes only the outbound calls you configure: the metrics source and
  the notifier webhooks. There is no telemetry or phone-home.
- Zero runtime dependencies means no transitive supply chain to audit.
