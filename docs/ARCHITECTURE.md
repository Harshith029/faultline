# FAULTLINE Architecture

FAULTLINE is a reliability-intelligence showcase: a deterministic cascade-failure
detection engine with an AI explanation layer, presented through an interactive
incident-playback dashboard.

The system has one governing design rule: **detection is deterministic math;
AI only explains.** Nothing the LLM produces can trigger, suppress, or alter a
detection.

## System overview

```
                        ┌─────────────────────────────────────────┐
                        │              Browser (React)            │
                        │                                         │
  raw telemetry ──────▶ │  detectionEngine.js  ──▶  17 components │
  (rawTelemetry.js      │  z-scores · qualification · R-score     │
   or user CSV)         │  counterfactuals · baselines            │
                        └───────────────┬─────────────────────────┘
                                        │ GET /timeline (optional enrichment)
                                        ▼
   S3 (dataset) ──▶ DynamoDB ──▶ Lambda (timelineHandler) ──▶ Bedrock (Claude 3 Haiku)
   seed source      windows      serves timeline + invokes      root-cause hypothesis
                                 AI at trigger                  (2.5s timeout + fallback)
```

Key property: the dashboard is **fully functional offline**. All detection math
runs client-side; the AWS path only enriches the root-cause hypothesis with a
live Bedrock inference when reachable.

## Dependency map

```
frontend/dashboard/src
├── main.jsx ──▶ ErrorBoundary ──▶ App
├── App.jsx  ──▶ LandingPage (eager, default view)
│            └─▶ FaultlineDashboard (React.lazy, loads on #demo)
├── lib/
│   ├── detectionEngine.js   pure functions, zero dependencies
│   └── parseTelemetry.js    CSV parsing for user-supplied data
├── data/
│   └── rawTelemetry.js      12-window reference scenario (raw values)
├── timelineApi.js           fetch client for the Lambda endpoint
└── components/
    ├── FaultlineDashboard   orchestrator: runs engine, owns activeWindow state
    ├── DetectionEnginePanel engine math surfaced per window + detector comparison
    ├── CounterfactualPanel  what-if mitigation replay (runCounterfactual)
    ├── BringYourOwnPanel    CSV upload → runDetection on user data
    ├── TimelineScrubber · DriftChart · RiskTimelineChart · ConvergenceGauge
    ├── SignalPanel ─▶ SignalBadge · SignalConvergenceHeatmap
    ├── LeadTimeCounter · ConfidenceTrendChart · MetadataBar
    ├── HypothesisCard       Bedrock/fallback hypothesis display
    ├── AIInsightPanel       per-window operator narration
    ├── IncidentChatAgent    guided incident Q&A sidebar
    └── ServiceArchitectureMap  SVG dependency graph (7 nodes, cascade B→D→F)
```

Data flows strictly downward: `rawTelemetry → runDetection → windows[] → props`.
No global state library; `FaultlineDashboard` owns `activeWindow` and the memoized
engine result.

## Detection pipeline

1. **Baseline** — first 4 windows establish mean μ and σ per metric; σ is floored
   at 10% of μ so a quiet baseline cannot inflate z-scores.
2. **Normalize** — `z = (x − μ) / σ` per metric per window.
3. **Qualify** — a metric qualifies only when z ≥ 2.0 for ≥ 2 consecutive
   windows; single-window spikes are ignored.
4. **Score** — `R = mean_z(qualified) × ln(1 + signal_count) × W`.
5. **Trigger** — `R ≥ 3.0` fires detection; `R ≥ 9.0` marks the modeled outage.

Reference scenario result: latency qualifies at W6, retry at W8 (trigger,
R = 3.96, 2 signals), errors at W9, SLO breach at W11, outage at W12. A static
error-rate SLO alert fires 3 windows after FAULTLINE.

`dataset/faultline_windows.json` is **generated** from this pipeline by
`scripts/generateDataset.mjs` — regenerate it after changing `rawTelemetry.js`
or engine parameters; never edit it by hand.

## Live mode (real telemetry)

`GET /timeline?source=live` makes the Lambda pull the last 60 one-minute
windows of **real CloudWatch metrics for this deployment's own API Gateway**
(`Faultline-API`): p99 latency, 4XX rate (retry-pressure proxy), and 5XX rate.
The raw series is returned to the browser, where the same detection engine
runs on it with `sigmaFloorAbs` floors (100 ms / 2% / 2%) to keep sparse,
low-traffic baselines from inflating z-scores. The dashboard's Live toggle
switches the entire pipeline to this data; scenario-bound panels (narration,
chat, architecture map, counterfactual) hide because they describe the curated
incident, not the live system. FAULTLINE monitors its own production
infrastructure — cold starts and deploy-time 5XX errors are visible in the
live data.

Required IAM: `cloudwatch:GetMetricData` on `FaultlineTimelineRole`
(inline policy `FaultlineCloudWatchRead`). Lambda env: `LIVE_API_NAME`.

## Request flow (AWS enrichment path)

```
GET {API_URL}/timeline?service_id=B
  → API Gateway (prod stage, CORS)
  → Lambda timelineHandler
      1. validate service_id (^[A-Za-z0-9_-]{1,64}$)
      2. DynamoDB Query (PK service_id, SK window_timestamp)
      3. if no triggered window → return windows
      4. else InvokeModel (Claude 3 Haiku, temp 0.2, max 300 tokens)
         · 2.5s timeout race
         · JSON schema validation (root_service, mechanism,
           cascade_path, evidence[3])
         · on any failure → hypothesis_fallback from the stored record
      5. return { service_id, windows } with hypothesis attached
```

The frontend treats this call as optional: failures are swallowed and a local
fallback hypothesis (consistent with the engine's numbers) is used instead.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `VITE_API_URL` | frontend build | API Gateway base URL; unset → offline mode |
| `AWS_REGION`, `TABLE_NAME`, `BEDROCK_MODEL_ID` | Lambda env | backend wiring |
| `DATASET_BUCKET` | seed script env | S3 source for `scripts/seed.js` |

## Testing & CI

- `npm test` (in `frontend/dashboard/`) — unit tests for the engine and CSV
  parser via Node's built-in test runner.
- `npm run verify:engine` — end-to-end scenario assertion: reproduces the
  cascade, beats baseline detectors, counterfactual averts when acting early.
- `.github/workflows/ci.yml` runs tests, verification, and the production build
  on every push and pull request.

## Deployment

- **Frontend:** any static host serves `dist/`. For AWS Amplify manual
  deployments, `scripts/deploy.ps1` automates it (set `FAULTLINE_APP_ID` and
  `VITE_API_URL` env vars): build, zip the *contents* of `dist/` with
  forward-slash entry names, `create-deployment` → PUT zip → `start-deployment`.
- **Backend:** Lambda deployed manually; repo changes to `handler.js` do not
  take effect until re-deployed.
- **Data:** `scripts/seed.js` loads the generated dataset from S3 into
  DynamoDB; `scripts/verify.js` asserts the seeded shape.

## Known boundaries

- The scenario timeline is curated; live mode ingests real CloudWatch metrics
  on demand, but there is no continuous streaming/alerting path yet (roadmap).
- The API endpoint is unauthenticated with permissive CORS — acceptable for a
  public demo, not for production (add API keys/usage plans before real use).
- `AIInsightPanel` narration and `IncidentChatAgent` answers are curated copy
  aligned to the reference scenario, not live inference (roadmap: live Bedrock
  chat).
