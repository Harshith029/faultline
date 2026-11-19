# Operating the FAULTLINE agent

The agent is a long-running process that collects telemetry on an interval,
scores cascade risk, manages incidents, and exposes an HTTP API. It has zero
runtime dependencies and holds no state it cannot rebuild except its incident
history.

## Lifecycle of one tick

```
source.collect()
  → validate samples             (a missing/NaN metric rejects the sample; never coerced to 0)
  → place in the series          (replays and late samples dropped; a hole breaks sustained runs)
  → append to per-service ring buffer (capacity = detector.historyWindows)
  → runDetection() on the buffer (@faultline/core, the same engine the UI uses)
  → evaluate the newest window
  → AlertManager: open / update / resolve / suppress
  → notifiers (up to 4 at once, awaited for at most half an interval) + durable store
```

A tick that overruns its interval will not overlap with the next one; the
skipped cycle is logged as `agent.tick_skipped`. A slow notifier cannot cause
that on its own — see [Alert routing](#alert-routing).

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

## Time continuity

"Sustained for `minSustain` windows" is a claim about consecutive moments in
time, so the buffer only ever holds distinct, ordered observations and the
engine never counts a run across a hole:

| Sample | What happens | Counted as |
|---|---|---|
| Same source timestamp as the newest buffered sample | Dropped: a replay of an observation already counted (CloudWatch re-returning its latest datapoint, an exporter repeating itself) | `duplicateSamples`, `faultline_samples_dropped_total{reason="duplicate"}` |
| Older than the newest buffered sample | Dropped: it would reorder history | `outOfOrderSamples`, `{reason="out_of_order"}` |
| Stamped more than 5 minutes ahead of the agent's clock | Rejected as incomplete (`timestamp` missing): it cannot order the series | `incompleteSamples` |
| More than `maxSampleGapSeconds` after the previous one | Accepted, but the hole is a break: a sustained run restarts after it | `sampleGaps`, `faultline_sample_gaps_total` |
| More than `historyWindows × intervalSeconds` after the previous one | The service starts over and warms up: everything buffered predates the history it stands for | `historyResets`, `faultline_history_resets_total` |

A hole is measured against each service's *own* spacing: the median gap
between its buffered samples, never less than `intervalSeconds`. A source with
a new datapoint once a minute, polled every 15 s, is therefore a one-minute
series — its replays are dropped and what remains is judged against a minute,
not against 15 s (which would call every sample a gap and never let a signal
sustain). `detector.maxSampleGapSeconds` overrides the default tolerance of
1.5 × that spacing: under the default a late sample is tolerated and a missing
one restarts the run, including a collection the agent itself skipped because
the previous one overran.

The duplicate and ordering rules apply only between two timestamps the
*source* reported (an HTTP row's `timestamp`, a CloudWatch datapoint's time),
and the kind is remembered with each buffered sample across restarts.
Prometheus and the synthetic source report none, so those samples are stamped
with the start of their collection cycle — consecutive cycles are then exactly
one interval apart however long collection took — and only the gap rules
apply. The counters appear under `dataQuality` in `GET /api/state`,
with the most recent event in `lastContinuityEvent`.

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

Your source must emit a numeric field per metric name. A sample with any
configured metric missing or non-numeric is rejected and counted
(`faultline_incomplete_samples_total`), never coerced to 0 — a zero is a
measurement, and inventing one would turn lost telemetry into perfect health.
The Prometheus and CloudWatch sources refuse to start if they cannot supply a
configured metric, including ones introduced by a per-service rule.

Two rules make a metric set work well:

1. **Pick signals that move for different reasons but fail together.** The
   detector's whole advantage is convergence, so metrics that are near-duplicates
   of one another (p95 and p99 latency) inflate the signal count without adding
   evidence. A saturation metric, a work-backlog metric, and an outcome metric is
   a strong trio.
2. **Say which way is bad.** By default only upward drift qualifies. If a
   metric fails by dropping — cache hit rate, throughput, success rate — set
   its direction so a sustained fall counts:

   ```json
   "direction": { "throughput": "down", "cache_hit_rate": "down" }
   ```

   `"both"` qualifies movement either way. Direction can also be overridden
   per service. Qualified signals for non-default directions carry a
   `direction` field, and reported z-scores keep their sign.

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
82.6% while recall stays at 100%, at a cost of roughly two windows of extra
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

Notifications are sent up to four at a time, so a burst of incidents against a
slow webhook costs about a quarter of the timeouts it would one after another.
The limit is shared by every tick, so a receiver that is already slow is never
sent more at once.

A slow receiver cannot hold up detection either. A tick waits for its
notifications for at most half the collection interval; any still sending then
finish in the background, logged as `notify.deferred` with the number of
services still pending. Waiting any longer could push the tick past the next
collection, and a skipped collection is a hole in every service's series that
restarts their sustained runs (see [Time continuity](#time-continuity)).

Sending in the background keeps the guarantees of a tick that waited:

- A service's notifications go out one at a time, in the order they were
  decided. An incident never has two in flight, and a resolve decided while its
  open is still sending waits for that open. A notification that had to wait
  carries the incident as it stands when sent: an open that goes out after its
  incident recovered already shows `status: "resolved"`, and `event` says which
  transition it announces.
- A window does not retry an open that is still being sent. If that attempt
  fails, the next window retries it as usual.
- Each incident is saved again once its notification settles, so the stored
  record carries what was actually sent.
- Shutdown (`SIGTERM`) waits for them within the same five-second grace it gives
  a collection in flight. Any still sending after that are logged as
  `agent.shutdown_delivery_abandoned`. An open among them is sent again after
  the restart if its incident is still firing; a resolve is not.
- Retiring a service waits for any still being sent for that service (see
  [Retiring services](#retiring-services)).

Notifier failures are logged as `notify.failed` and never interrupt detection.
They are also never mistaken for delivery:

- `incident.notifiedAt` is set only once **every** notifier accepted the open.
- `incident.deliveredTo` lists the notifiers that did (as `index:type`, e.g.
  `1:webhook`). While the incident keeps firing, each window retries only the
  ones missing from that list, so a webhook that was down pages when it comes
  back and the channels that already have the alert are not paged twice. A
  partial delivery is logged as `incident.delivery_incomplete`.
- A resolve goes only to the notifiers that received the open.

If an incident resolves before a failed notifier recovers, that notifier never
hears about it — the incident record and the logs still show it.

## Cooldown

After an incident resolves, `alerting.cooldownSeconds` holds paging for a
re-trigger on the same service. The re-trigger is still opened and recorded —
marked with `heldUntil` — so a flapping service leaves a complete history. It
pages only if it is still firing once the cooldown ends; if it resolves inside
the cooldown, nobody is woken for it.

## Retiring services

A service that stops reporting degrades `/health` (`service_telemetry_stale`)
until it returns — exactly right for an exporter that broke, and wrong for a
service you decommissioned. Retire it:

```bash
curl -X DELETE -H "Authorization: Bearer $FAULTLINE_API_TOKEN" localhost:8787/api/services/old-worker
```

Its buffer, freshness and ranking entry are dropped at once and the change is
saved straight away, so a restart does not bring it back. If it had an open
incident, that incident is closed with status `retired` and no notification:
nothing was observed to recover, and the agent never reports a recovery it did
not see. Retiring is a write — it needs the full token and passes the same
cross-origin checks as silences.

`detector.retireAfterSeconds` retires services automatically once they have
sent nothing at all — not even an incomplete sample — for that long. It is off
by default, must be longer than `noDataGraceSeconds` (so a vanished service is
always reported stale first), and never retires a service with an open
incident: one that is firing and then goes silent is the one a human should
look at.

Automatic retirement also removes that service's stale-telemetry alarm, and a
service that died looks exactly like one that was decommissioned. If you enable
it, alert on it:

```yaml
- alert: FaultlineServiceRetiredSilently
  expr: increase(faultline_services_retired_total{reason="silent"}[1h]) > 0
```

`GET /api/state` lists the last 20 retirements, with reason and time, under
`recentRetirements`. A request to `DELETE /api/services/:name` first waits, for
up to ten seconds, for a collection in flight and for any alert to that service
still being sent, since either could still write that service's incident. If
one is stuck, the request answers `503` with `Retry-After` rather than waiting
on it.

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /livez` | Liveness: the process is up and its collection loop is making progress. `503` only when a collection has been stuck for 5 intervals (at least 60 s) or the agent is stopping — never because telemetry is missing |
| `GET /health` | Telemetry readiness. `503` while collection is failing, no valid telemetry has arrived within `noDataGraceSeconds`, a previously seen service has gone stale, or services are being refused at `maxServices` |
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
| `DELETE /api/services/:name` | Retire a service (see *Retiring services*). `404` if it is not tracked. |

### Authentication

The API defaults to open, which is acceptable only on localhost — it can create
silences and therefore suppress your alerting — and the agent refuses to bind
anywhere else without a token.

Localhost is not the same as safe: a web page open in the operator's browser
can send requests to `127.0.0.1`. So the token-less agent also:

- refuses any write that carries an `Origin` header not listed in
  `server.corsOrigin` (browsers attach one to every cross-origin POST/DELETE,
  including "simple" requests they send without a preflight);
- requires `Content-Type: application/json` to create a silence, so a page
  cannot send one cross-origin without a preflight it will fail;
- answers only to a loopback `Host` header (`localhost`, `127.0.0.1`, `[::1]`),
  which defeats DNS rebinding — a hostile domain re-pointed at 127.0.0.1;
- sends no CORS headers unless `server.corsOrigin` is set. `"*"` allows any
  origin to *read*; browser *writes* always need an origin listed explicitly.

curl, scripts and Prometheus send no `Origin` header and are unaffected. Set a
token and it is enforced:

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
| `GET /health`, `GET /livez` | **Always anonymous**, and answered on any `Host` header. Load balancers and Kubernetes probes reach them before any credential exists, by pod IP; neither exposes telemetry |

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

Exposed series include `faultline_up`, `faultline_live` (the `/livez` check),
`faultline_telemetry_healthy` (the `/health` check), `faultline_ticks_total`,
`faultline_collect_errors_total`, `faultline_empty_collections_total`,
`faultline_incomplete_samples_total`, `faultline_samples_dropped_total{reason}`,
`faultline_sample_gaps_total`, `faultline_history_resets_total`,
`faultline_evaluation_errors_total`, `faultline_services_rejected_total`,
`faultline_services_retired_total`, `faultline_seconds_since_data`,
`faultline_risk_score{service}`, `faultline_qualified_signals{service}`,
`faultline_service_firing{service}`, `faultline_service_silenced{service}`,
`faultline_service_stale_seconds{service}`, `faultline_silences_active`,
`faultline_incidents_total` and `faultline_incidents_open`.

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

Restored samples are held to the same contract as live ones, under the
configuration the agent is running *now*: a sample missing a metric added to
the config since the snapshot, or out of order, is discarded and counted
(`samplesDropped`, in the startup log and in `stateRestored`), so a config
change cannot turn old state into evaluation errors. A write that fails leaves
the state marked unsaved and is retried on a backoff (at most once a minute)
rather than waiting for the next change.

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
`HEALTHCHECK` that polls `/livez`. It deliberately does not poll `/health`: an
orchestrator that replaces unhealthy containers would otherwise restart the
agent every time an exporter went quiet. Alert on `/health` (or
`faultline_telemetry_healthy == 0`) instead.

**systemd**

```ini
[Service]
ExecStart=/usr/bin/node /opt/faultline/packages/agent/bin/faultline.js start --config /etc/faultline/config.json
Environment=FAULTLINE_WEBHOOK_URL=https://hooks.slack.com/services/...
Restart=always
User=faultline
```

**Kubernetes** — a single-replica Deployment. Point `livenessProbe` at
`/livez`, never at `/health`: restarting the agent cannot fix a missing
exporter, so a telemetry-dependent liveness probe only adds a restart loop to
an outage. `/health` is the telemetry readiness signal. Use it as the
`readinessProbe` if you want the pod marked unready while telemetry is
impaired — that also removes it from Service endpoints, so scrape it by pod
rather than through the Service — or keep readiness on `/livez` and alert on
`faultline_telemetry_healthy`. Do not scale beyond one replica per config:
replicas keep independent buffers and would alert independently. Shard by
running separate deployments with different `source` scopes instead.

```yaml
livenessProbe:
  httpGet: { path: /livez, port: 8787 }
  periodSeconds: 30
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /health, port: 8787 }
  periodSeconds: 30
```

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `/health` returns 503 | 3+ consecutive collection failures | Check source reachability; `agent.collect_failed` logs carry the error |
| Services stuck `warming_up` | Fewer samples than required | Confirm the source returns a stable `service` label every tick |
| Warm-up after every restart | Snapshot older than the restore window | Raise `storage.restoreMaxAgeSeconds`, or check the state file is on a persistent volume |
| `agent.tick_skipped` | Collection is slower than the interval | Raise `intervalSeconds` or narrow the queries |
| Alerts on a quiet service | Baseline variance near zero | Set `sigmaFloorAbs` |
| Long incident self-resolves while still broken | Incident absorbed into its rolling baseline | Raise `historyWindows` |
| `incident.delivery_incomplete` | A notifier rejected or timed out on the alert | Check the `notify.failed` log for that notifier; it is retried each window while the incident fires |
| `notify.deferred` | Notifications were still sending when the tick's delivery budget (half the interval) ran out | Detection is unaffected and they finish in the background; check the receiver's latency and any `notify.failed` for it |
| `/health` reason `service_capacity_exceeded` | More distinct services than `detector.maxServices` | Usually a high-cardinality `service` label (a pod or request id); fix the label, or raise the cap deliberately |
| API returns `421` | Token-less agent reached with a non-loopback `Host` header | Use `localhost`/`127.0.0.1`, or set a token |
| API write returns `403 cross-origin write refused` | A browser page on another origin tried to write | Expected for untrusted pages; list a trusted origin in `server.corsOrigin` |
| `/health` reason `service_telemetry_stale` for a service you removed | The agent still expects it | `DELETE /api/services/<name>`, or set `detector.retireAfterSeconds` |
| `/livez` returns 503 `collection_stalled` | A collection has been in flight for 5+ intervals | The process is wedged; let the orchestrator restart it, then check the source's reachability and timeouts |
| `sample.out_of_order` warnings | The source sent observations older than ones already counted | Check the source's clock, and whether it replays history |
| `service.history_reset` | No telemetry for longer than the whole history window | Expected after a long outage; the service warms up again |
| `sampleGaps` climbing, sustained runs keep restarting | Samples are regularly missing, or collections overrun the interval and the next one is skipped | Fix the source or raise `intervalSeconds`; to accept the holes knowingly, set `detector.maxSampleGapSeconds` |

## Security

- No secrets belong in the config file. Use `urlEnv` or `tokenEnv`; literal
  tokens in config are rejected at startup.
- Set `FAULTLINE_API_TOKEN` for anything beyond localhost, and enable TLS or
  terminate it at your ingress.
- The agent makes only the outbound calls you configure: the metrics source and
  the notifier webhooks. There is no telemetry or phone-home.
- Zero runtime dependencies means no transitive supply chain to audit.
