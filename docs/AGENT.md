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
| `GET /api/state` | Current risk, signals, and metrics per service. |
| `GET /api/incidents` | Incident history. Filters: `status`, `service`, `limit`. |
| `GET /api/incidents/:id` | One incident. |
| `GET /api/windows?service=` | Full engine output for charting. |
| `GET /metrics` | Prometheus exposition format. |
| `POST /api/inject?service=` | Inject a synthetic fault (synthetic source only). |

The API is unauthenticated and CORS-open by design: it is meant to bind to
localhost or a private network. **Do not expose it to the internet.** Put it
behind your ingress, service mesh, or an authenticating reverse proxy.

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

## Persistence

Incidents are written to `storage.path` as JSON, atomically (temp file +
rename) and debounced, so a crash mid-write cannot corrupt the file. History is
capped at `storage.maxIncidents`. On restart the file is reloaded; if it is
missing or unreadable the agent starts with an empty history rather than
failing to boot.

Live detection state (the rolling buffer) is intentionally **not** persisted —
after a restart each service warms up again rather than resuming from a
baseline that may be hours stale.

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
| `agent.tick_skipped` | Collection is slower than the interval | Raise `intervalSeconds` or narrow the queries |
| Alerts on a quiet service | Baseline variance near zero | Set `sigmaFloorAbs` |
| Long incident self-resolves while still broken | Incident absorbed into its rolling baseline | Raise `historyWindows` |

## Security

- No secrets belong in the config file. Use `urlEnv` or environment variables.
- The API is unauthenticated; bind it to localhost or a private network.
- The agent makes only the outbound calls you configure: the metrics source and
  the notifier webhooks. There is no telemetry or phone-home.
- Zero runtime dependencies means no transitive supply chain to audit.
