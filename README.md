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
cd faultline
npm install
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

**Your own metrics, not just these three.** Latency/retries/errors are only the defaults. The engine is metric-agnostic — give it any numeric signals your system emits:

```json
{
  "detector": {
    "metrics": ["queue_depth", "consumer_lag", "gc_pause_ms"],
    "minSignals": 2,
    "sigmaFloorAbs": { "queue_depth": 50, "consumer_lag": 100, "gc_pause_ms": 5 }
  }
}
```

Convergence scoring works identically: any two of those drifting together opens an incident.

**Different services, different rules.** A checkout API and a nightly batch job should not share a threshold, so any detector parameter can be overridden per service. Exact names beat wildcards, and the first matching wildcard wins:

```json
"services": [
  { "match": "checkout-api", "name": "tier-1", "criticalityWeight": 3, "triggerThreshold": 2.5 },
  { "match": "queue-*", "metrics": ["queue_depth", "consumer_lag"] },
  { "match": "batch-*", "minSustain": 4, "triggerThreshold": 6 }
]
```

`GET /api/state` reports which profile matched each service, so you can tell at a glance whether a rule is actually in effect.

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

## Does it actually work?

Two answers, and the honest one is second.

### On real production telemetry

`npm run backtest` replays the [Server Machine Dataset](https://github.com/NetManAIOps/OmniAnomaly) — 28 days of real server telemetry, 38 channels per machine, incidents labelled by the operators who ran the systems. Detection is replayed causally (no detector sees the future) across 41 labelled incidents on 4 machines, using **all 38 channels with no hand-picking**.

| Detector | Precision | Recall | F1 | False alerts |
|---|---:|---:|---:|---:|
| **FAULTLINE** | **14.1%** | 80.5% | **23.9%** | 544 |
| Sustained 3σ | 11.3% | 85.4% | 20.0% | 430 |
| Single metric 3σ | 7.3% | 97.6% | 13.5% | 1019 |

FAULTLINE wins on F1 and roughly doubles the precision of a single-metric threshold while nearly halving its false alerts — **and 14% precision is still too noisy to page a human unattended.** Both facts are true and neither is hidden.

A parameter sweep confirms this is not a tuning problem: precision never exceeds 16.5% at any threshold, and demanding more converging signals *lowers* it while destroying recall. Most false positives are real, sustained, multi-channel excursions that operators simply did not call incidents — deploys, batch jobs, capacity shifts. **Use it today as a triage and ranking signal, not as an unattended pager.** Full analysis, per-machine breakdown and the roadmap that would move the number: [docs/BACKTEST.md](docs/BACKTEST.md).

### On synthetic scenarios

`npm run benchmark` runs every detector against 12 labeled scenarios × 20 seeds — five cascades that **must** be caught, and seven adversarial non-incidents (single-window spikes, transient blips, deploy step-changes, 3× noise, seasonal load, organic growth) that **must not** page anyone.

⚠️ **These scenarios were designed from the same mental model as the detector, so they largely measure whether the implementation matches its own assumptions.** They are a regression test, not evidence of field performance — the real-world numbers above are ~6× worse. Read them as "does the math still behave as specified", nothing more.

| Detector | Precision | Recall | F1 |
|---|---:|---:|---:|
| **FAULTLINE (strict)** | **83.3%** | **100%** | **90.9%** |
| FAULTLINE (default) | 69.4% | 100% | 82.0% |
| Sustained 3σ | 59.2% | 100% | 74.3% |
| Single metric 3σ | 35.5% | 66.0% | 46.2% |
| Static SLO (3×) | 33.3% | 3.0% | 5.5% |

Both FAULTLINE profiles catch **every** cascade in the suite. The static SLO baseline catches 3% — it is a lagging outcome metric, which is exactly the problem this project exists to address. Median lead over that baseline: **7 windows**.

The honest caveats, straight from the same run:

- **A blip that lasts exactly `minSustain` windows still fires** on the default profile (`transient-multi-spike`, 100%). The strict profile (`minSustain: 3`) drops that to 0% and is what you should run in noisy environments — it costs about one window of delay.
- **A permanent step change still alerts** (`deploy-step-change`, 100%). With a fixed baseline this is mathematically indistinguishable from a real cascade. The agent's rolling baseline absorbs it over time, but you will get an alert first. Arguably correct — a deploy that permanently moves all three metrics is worth knowing about — but it is a false positive against the label, so it is reported as one.
- **Sustained 3σ fires ~2 windows earlier** than FAULTLINE and catches everything too. It is simply far noisier (59.2% vs 83.3% precision). Speed is not free.

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
| `detector.metrics` | latency/retry/error | Any numeric signals your source emits |
| `services[]` | `[]` | Per-service overrides of any detector parameter |
| `detector.minSignals` | `2` | Qualified signals required to trigger — enforces convergence |
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
npm test              # 115 unit + integration tests
npm run verify:engine # reference cascade assertion
npm run benchmark     # synthetic precision/recall/lead time vs baselines
npm run fetch:dataset # download the Server Machine Dataset (not vendored)
npm run backtest      # replay real production telemetry
```

Covers the engine math, config validation, incident state machine, every telemetry source, the HTTP API, and end-to-end runs asserting that a cascade produces exactly one alert, reaches the webhook, persists, and resolves.

## Roadmap

Driven by what the [backtest](docs/BACKTEST.md) actually showed. Its first three items have all been tried and rejected on measurement: **change-point detection** made precision and recall worse; **per-channel learned thresholds** improved aggregate F1 while sending one machine in four completely blind; **robust median/MAD statistics** proved indistinguishable from mean/σ once alert volume was held constant (kept as an option, defaulted off).

Three refinements of *how the numbers are computed* changed nothing, which is itself the most useful result so far: on this data the limit is not statistical technique but that "two channels drifted up together" does not separate the excursions operators called incidents from the ones they did not. The remaining work that changes the *signal* rather than the arithmetic is correlation structure.

- **Change-point detection** — most false positives are level shifts, not drift. Recognizing "this is a new normal" would remove a whole class of them.
- **Per-channel learned thresholds** — one global `zThreshold` across heterogeneous channels is crude.
- **Seasonality awareness** — daily and weekly cycles currently look like drift.
- **Correlation-weighted convergence** — weight signals by whether those channels are *historically* coupled, separating genuine cascades from coincident movement.
- OpenTelemetry-native source and trace-derived dependency graphs
- Optional LLM explanation layer in the agent (already present in the AWS Lambda variant)

## Contributing

Issues and PRs welcome. One invariant: **detection stays deterministic and auditable — AI may explain, never decide.** Run `npm test` before submitting.

## License

[MIT](LICENSE) — use it, fork it, ship it.

Built by **Team Progsolve**. Recognized as a Top 1000 Semi-Finalist in the AWS Builder Center AIdeas Challenge.
