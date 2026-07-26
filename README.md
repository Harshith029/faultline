# FAULTLINE

### Catch cascade failures while there is still time to act

[![CI](https://github.com/Harshith029/faultline/actions/workflows/ci.yml/badge.svg)](https://github.com/Harshith029/faultline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](packages/agent/package.json)

Static thresholds fire when you are already failing. FAULTLINE watches how latency, retries, and errors **drift together over time** and opens an incident while the failure is still forming — typically several windows before an SLO alert would trip.

It is a real monitoring agent, not a dashboard: it runs continuously, pulls metrics from Prometheus / CloudWatch / any HTTP endpoint, scores cascade risk with auditable math, manages incident lifecycle with dedup and cooldown, and alerts your webhook.

**Zero runtime dependencies. Runs anywhere Node runs.**

---

## See it detect a real cascade in 30 seconds

```bash
git clone https://github.com/Harshith029/faultline.git
cd faultline && npm install
npm run agent:demo
```

The agent starts, streams synthetic telemetry for three services, and ~15 seconds in a cascade begins on `checkout-api`. You will see it caught live:

```
INFO  agent.started source=synthetic intervalSeconds=1 triggerThreshold=3
WARN  incident.opened incident=inc_checkout-api_ms1m52 service=checkout-api R=3.71 signals=2
WARN  [FAULTLINE] WARNING checkout-api — cascade detected. R=3.71 (threshold crossed)
      with 2 converging signal(s): p99_latency z=3.6, retry_rate z=3.9
INFO  incident.resolved incident=inc_checkout-api_ms1m52 windowsFiring=14 peakR=8.24
```

While it runs, the agent is serving a real API:

```bash
curl localhost:8787/health          # liveness, tick count, source, error streak
curl localhost:8787/api/state       # current risk score per service
curl localhost:8787/api/incidents   # incident history
curl localhost:8787/metrics         # Prometheus exposition format
curl -X POST localhost:8787/api/inject?service=payments   # inject a fault on demand
```

Or with Docker:

```bash
docker compose up
```

---

## Point it at your own metrics

Everything is driven by one config file. Copy [`packages/agent/faultline.config.example.json`](packages/agent/faultline.config.example.json) and edit the `source` block.

**Prometheus / Thanos / Mimir / VictoriaMetrics**

```json
{
  "source": {
    "type": "prometheus",
    "options": {
      "url": "http://prometheus:9090",
      "serviceLabel": "service",
      "queries": {
        "p99_latency": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[1m])) by (le, service)) * 1000",
        "retry_rate":  "sum(rate(http_client_retries_total[1m])) by (service) / clamp_min(sum(rate(http_requests_total[1m])) by (service), 1) * 100",
        "error_rate":  "sum(rate(http_requests_total{status=~\"5..\"}[1m])) by (service) / clamp_min(sum(rate(http_requests_total[1m])) by (service), 1) * 100"
      }
    }
  }
}
```

**Any HTTP endpoint you already have** — `mapping` renames incoming fields, so an existing internal metrics route usually needs no new code:

```json
{ "source": { "type": "http", "options": {
  "url": "https://internal.example/metrics.json",
  "mapping": { "service": "svc", "p99_latency": "latency_ms" }
}}}
```

**Amazon CloudWatch** (needs `npm install @aws-sdk/client-cloudwatch`):

```json
{ "source": { "type": "cloudwatch", "options": {
  "region": "us-east-1",
  "namespace": "AWS/ApiGateway",
  "targets": [{ "service": "checkout-api", "dimensions": { "ApiName": "prod-api" } }]
}}}
```

Then run it, with secrets supplied by the environment — never committed:

```bash
FAULTLINE_WEBHOOK_URL=https://hooks.slack.com/services/... \
  node packages/agent/bin/faultline.js start --config my-config.json
```

The webhook payload includes a `text` field, so Slack, Mattermost, and Discord accept it directly; everything else can read the structured `incident` object.

---

## How detection works

Three equations. No trained model in the detection path — every alert can be re-derived by hand.

**1. Normalize** — score each metric against its own recent baseline:

```
z = (value − mean) / standard_deviation
```

**2. Qualify** — a single bad window is noise; only sustained drift counts:

```
z ≥ 2.0  AND  persists for ≥ 2 consecutive windows
```

**3. Score & trigger** — converging signals compound risk:

```
R = mean_z × ln(1 + signal_count) × W      →  R ≥ 3.0 opens an incident
```

Because `ln(1 + n)` grows with the number of *converging* signals, three metrics at 3σ score far higher than one metric at 9σ. That is the whole thesis: **cascades announce themselves through convergence, not through any single number going red.**

On the bundled reference incident, detection fires **3 windows before** a static 2% error-rate SLO alert would — measured, not asserted: run `npm run verify:engine`.

### Incident lifecycle

Detection alone would page you every window. The agent adds the operational half:

| Behaviour | Why it exists |
|---|---|
| One incident per cascade, not one alert per window | Alert fatigue is how monitoring gets ignored |
| Resolves only after N consecutive clean windows | One good sample mid-incident means nothing |
| Cooldown after resolution | Stops a flapping service from paging all night |
| Notifier failures are isolated | A dead webhook must not stop detection |
| Source failures degrade `/health`, don't crash | Monitoring that dies during an outage is worthless |

---

## Use it as a library

The engine is a dependency-free ES module ([`@faultline/core`](packages/core/detectionEngine.js)):

```js
import { runDetection, compareDetectors } from '@faultline/core'

const result = runDetection(windows)  // [{ window_number, p99_latency, retry_rate, error_rate }, ...]
result.detectionWindow                // first window where R crossed the threshold
compareDetectors(result)              // lead time vs static-SLO and single-metric detectors
```

---

## The dashboard (optional)

```bash
npm run dashboard   # http://localhost:5173
```

An incident-analysis UI over the same engine: scrub a cascade window by window, watch each z-score get derived from raw values, compare lead time against baseline detectors, run counterfactual mitigations ("what if we had acted at W6?"), and drop in your own CSV. Useful for postmortems and for understanding the math — the agent is what runs in production.

---

## Configuration reference

| Key | Default | Notes |
|---|---|---|
| `source.type` | `synthetic` | `synthetic` · `prometheus` · `http` · `cloudwatch` |
| `detector.intervalSeconds` | `60` | Collection cadence |
| `detector.historyWindows` | `40` | Rolling buffer size per service |
| `detector.baselineWindows` | `10` | Oldest N windows form the baseline |
| `detector.zThreshold` | `2.0` | Sigma required to count as elevated |
| `detector.minSustain` | `2` | Consecutive windows required to qualify |
| `detector.triggerThreshold` | `3.0` | R at which an incident opens |
| `detector.sigmaFloorAbs` | `null` | Per-metric minimum sigma; stops quiet baselines inflating z |
| `alerting.cooldownSeconds` | `300` | Suppress re-opening after resolution |
| `alerting.resolveAfterWindows` | `3` | Clean windows required to resolve |
| `server.port` | `8787` | HTTP API |

Env overrides: `FAULTLINE_WEBHOOK_URL`, `FAULTLINE_PORT`, `FAULTLINE_HOST`, `FAULTLINE_LOG_LEVEL`, `FAULTLINE_INTERVAL_SECONDS`, `FAULTLINE_STORAGE_PATH`, `FAULTLINE_SOURCE_TYPE`.

Full operational detail: [docs/AGENT.md](docs/AGENT.md) · architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Project layout

```
packages/core/      detection engine + CSV parser (zero deps, shared)
packages/agent/     the monitoring agent: sources, detector, alerting, API
frontend/dashboard/ incident-analysis UI (optional)
backend/lambda/     AWS Lambda variant for serverless deployments
docs/               architecture and operations
```

## Testing

```bash
npm test              # 84 unit + integration tests
npm run verify:engine # reference cascade assertion
```

Covers the engine math, config validation, incident state machine, every telemetry source, the HTTP API, and end-to-end runs asserting that a cascade produces exactly one alert, reaches the webhook, persists, and resolves.

## Roadmap

- Adaptive per-service thresholds learned from history
- OpenTelemetry-native source and trace-derived dependency graphs
- Backtesting harness against public incident datasets (SMD, AIOps KPI) with precision/recall and lead-time reporting
- Optional LLM explanation layer in the agent (already present in the AWS Lambda variant)

## Contributing

Issues and PRs welcome. One invariant: **detection stays deterministic and auditable — AI may explain, never decide.** Run `npm test` before submitting.

## License

[MIT](LICENSE) — use it, fork it, ship it.

Built by **Team Progsolve**. Recognized as a Top 1000 Semi-Finalist in the AWS Builder Center AIdeas Challenge.
