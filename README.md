# FAULTLINE

### Reliability intelligence for distributed systems — detect cascade failures while there is still time to act

[![CI](https://github.com/Harshith029/faultline/actions/workflows/ci.yml/badge.svg)](https://github.com/Harshith029/faultline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Static thresholds fire when you are already failing. FAULTLINE reads the *early* behavioral signature of a cascade — sustained drift converging across latency, retries, and errors — and fires windows before a traditional SLO alert would. Detection is deterministic, auditable math; AI explains what the math found. Nothing the AI says can trigger or suppress a detection.

If FAULTLINE is useful to you, a ⭐ helps others find it.

---

## Quickstart — 60 seconds, no AWS account needed

```bash
git clone https://github.com/Harshith029/faultline.git
cd faultline/frontend/dashboard
npm install
npm run dev
```

Open http://localhost:5173 — you get the full product: a 12-window cascade incident to scrub through, the detection engine running live in your browser, a counterfactual "what if you acted earlier?" simulator, and a panel to run the engine on **your own telemetry CSV**. Everything works offline; no keys, no config, no telemetry leaves your machine.

Verify the engine yourself:

```bash
npm test               # 28 unit tests (node:test, zero extra deps)
npm run verify:engine  # end-to-end scenario assertion
```

---

## Use cases

**SRE / platform teams** — Export an hour of metrics from any incident as CSV (p99 latency, retry rate, error rate per minute), paste it into the *Bring your own telemetry* panel, and see when convergence detection would have fired versus your static alerts. Zero integration cost to evaluate the approach.

**Incident reviews & postmortems** — Replay telemetry window by window and answer "when could we have known?" quantitatively. The counterfactual simulator applies a mitigation (circuit breaker, pool scale-out, load shedding) at any window and re-runs the same detector on the recovered series — turning lead time from a claim into a number.

**Embedding the engine** — [`detectionEngine.js`](frontend/dashboard/src/lib/detectionEngine.js) is a dependency-free ES module. Lift it into your own pipeline:

```js
import { runDetection, compareDetectors } from './detectionEngine.js'

const result = runDetection(yourWindows) // [{ window_number, p99_latency, retry_rate, error_rate }, ...]
console.log(result.detectionWindow)      // first window where cascade risk R >= 3.0
console.log(compareDetectors(result))    // lead time vs static SLO and single-metric detectors
```

**Enterprises** — Self-host end to end in your own AWS account (optional, below). Telemetry stays in your infrastructure; the AI layer runs on your own Amazon Bedrock access. MIT licensed — audit it, fork it, ship it internally.

**Teaching & training** — An interactive sandbox for cascade dynamics: signal qualification, convergence scoring, lead time, and blast radius, with every number derivable by hand.

---

## How detection works

Three equations, fully auditable — no trained model in the detection path.

**1. Normalize** — every metric is scored against its own healthy baseline:

```
z = (value − mean) / standard_deviation
```

**2. Qualify** — single-window spikes are noise; only sustained drift counts:

```
z ≥ 2.0  AND  persists for ≥ 2 consecutive windows
```

**3. Score & trigger** — converging signals compound the cascade risk:

```
R = mean_z × ln(1 + signal_count) × W      →  R ≥ 3.0 fires detection
```

On the bundled scenario: latency qualifies at W6, retry amplification at W8 (trigger, R = 3.96), errors at W9, and the error-rate SLO breaches at W11 — meaning FAULTLINE fires **3 windows before a static SLO alert** and 4 before the modeled outage. The dataset is generated from the raw inputs by `scripts/generateDataset.mjs`, so displayed numbers and stored numbers can never diverge.

When detection fires, Amazon Bedrock (Claude) generates a structured root-cause hypothesis — root service, failure mechanism, cascade path, and evidence — with a strict timeout and a deterministic fallback. AI explains; it never detects.

---

## Run it on your own data

The CSV panel (and the engine) accepts any per-window series with these columns (common aliases like `latency_ms`, `p99`, `err_rate` are auto-mapped):

```csv
window,p99_latency,retry_rate,error_rate
1,112,0.4,0.63
2,82,0.67,0.24
...
```

At least 5 rows; the first 4 establish the baseline. Detection runs entirely client-side.

---

## Optional: self-hosted AWS live mode

The dashboard can also monitor **real infrastructure**: a Lambda pulls the last hour of CloudWatch metrics for an API Gateway (p99 latency, 4XX rate as retry-pressure proxy, 5XX rate) and the browser runs the same engine on it. In our reference deployment, FAULTLINE watches its own production API — cold starts and deploy-time 5XX errors show up in the live view.

To self-host, you provision in your own account:

| Component | Purpose |
|---|---|
| Lambda (Node 20) — [`backend/lambda/timelineHandler`](backend/lambda/timelineHandler/handler.js) | serves the timeline, live CloudWatch pulls, Bedrock invocation |
| API Gateway (REST) | fronts the Lambda (`GET /timeline`) |
| DynamoDB `Faultline-DriftSignals` | stores the scenario windows (seed with `scripts/seed.js`) |
| S3 bucket | holds `dataset/faultline_windows.json` for seeding |
| Amazon Bedrock (Claude 3 Haiku) | root-cause hypothesis at trigger |

IAM for the Lambda role: [`iam-policy.json`](iam-policy.json) plus `cloudwatch:GetMetricData` for live mode.

Environment variables:

| Variable | Where | Purpose |
|---|---|---|
| `VITE_API_URL` | frontend build/dev (`.env.local`, see `.env.example`) | your API Gateway base URL; unset = offline mode |
| `TABLE_NAME`, `BEDROCK_MODEL_ID`, `LIVE_API_NAME` | Lambda | backend wiring |
| `DATASET_BUCKET` | seed script | S3 source for seeding |

Frontend hosting is anything that serves static files (`npm run build` → `dist/`); `scripts/deploy.ps1` automates Amplify manual deploys if you use Amplify (configure via `FAULTLINE_APP_ID` / `VITE_API_URL` env vars).

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Project structure

```
frontend/dashboard/     React + Vite dashboard (works standalone, offline)
  src/lib/              detection engine + CSV parser (dependency-free ES modules)
  src/data/             raw telemetry for the bundled scenario
  test/                 unit tests (node:test)
backend/lambda/         timeline + live-telemetry + Bedrock Lambda
dataset/                generated scenario dataset (do not hand-edit)
scripts/                dataset generator, seeders, verifier, deploy script
docs/                   architecture documentation
```

## Testing & CI

- `npm test` — 28 unit tests covering baseline math, qualification, risk scoring, counterfactuals, and CSV parsing
- `npm run verify:engine` — asserts the engine reproduces the reference cascade and beats baseline detectors
- GitHub Actions runs tests, verification, and the production build on every push and PR

## Roadmap

- Continuous monitoring: scheduled detection with SNS/Slack alerting (today live mode pulls on demand)
- Adapters for Prometheus / OpenTelemetry metric sources
- Backtesting harness for public incident datasets (SMD, AIOps KPI) with precision/recall + lead-time reporting
- Live Bedrock-powered incident Q&A grounded in the active window

## Contributing

Issues and PRs are welcome. Keep the one invariant: **detection stays deterministic and auditable — AI only explains.** Run `npm test` and `npm run verify:engine` before submitting.

## License

[MIT](LICENSE) — use it, fork it, ship it.

## Credits

Built by **Team Progsolve**. FAULTLINE was a **Top 1000 Semi-Finalist** in the AWS Builder Center AIdeas Challenge — [read the project article](https://builder.aws.com/content/3AuBMFpv22Kue07Q8ZxD0n1GJGD/aideas-faultline-ai-assisted-predictive-reliability-intelligence-for-distributed-systems).

Contact: [harshith.pali3286@gmail.com](mailto:harshith.pali3286@gmail.com)
