# FAULTLINE Architecture

FAULTLINE performs **per-service multivariate drift triage**: for each service
independently, it scores how that service's own telemetry signals drift and
converge over time, and opens an incident when enough of them move together. It
ships as three pieces that share one detection engine.

**What it does not do.** There is no dependency graph, no distributed tracing,
no request-propagation model, and no deploy-event ingestion anywhere in the
pipeline. The agent buffers samples per service and evaluates each service on
its own. It can therefore tell you *"three metrics on checkout-api drifted
together, starting at 14:02"* — which is useful and earlier than three separate
alerts — but it cannot establish that checkout-api caused anything downstream.
Any cross-service ordering you see in the dashboard comes from the bundled demo
scenario and is labelled as sample content.

The governing rule: **detection is deterministic math. AI may explain a
detection; it can never cause or suppress one.**

## Components

```
packages/core/          @faultline/core — the detection engine
                        z-scores, signal qualification, cascade risk scoring,
                        detector comparison, counterfactual replay.
                        Zero dependencies. Runs in Node and in the browser.
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
packages/agent/        frontend/dashboard/     backend/lambda/
the monitoring agent   incident analysis UI    serverless variant
(production)           (postmortems, demos)    (API Gateway + Bedrock)
```

Everything that renders a number — the agent, the dashboard, the Lambda —
computes it with the same engine. There is no second implementation to drift.

## The agent (production path)

```
 ┌────────────┐   samples    ┌──────────────────┐  windows   ┌──────────────┐
 │  source    │─────────────▶│ RollingDetector  │───────────▶│@faultline/   │
 │ prometheus │  per service │ per-service ring │            │   core       │
 │ cloudwatch │              │ buffer           │◀───────────│ runDetection │
 │ http       │              └────────┬─────────┘  verdict   └──────────────┘
 │ synthetic  │                       │
 └────────────┘                       ▼
                              ┌──────────────┐
                              │ AlertManager │  open / update / resolve /
                              │ state machine│  suppress (cooldown)
                              └──────┬───────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              ┌──────────┐    ┌────────────┐   ┌────────────┐
              │ notifiers│    │   Store    │   │ HTTP API   │
              │ stdout   │    │ atomic     │   │ /health    │
              │ webhook  │    │ JSON, capped│  │ /api/*     │
              │ file     │    └────────────┘   │ /metrics   │
              └──────────┘                     └────────────┘
```

Module map (`packages/agent/src/`):

| File | Responsibility |
|---|---|
| `agent.js` | Lifecycle, tick loop, overlap guard, snapshot, graceful shutdown |
| `config.js` | Defaults, deep merge, validation, env overrides |
| `sources/` | Pluggable collectors; all expose `collect() → samples[]` |
| `buffer.js` | Per-service ring buffer |
| `detector.js` | Maps buffer → engine windows, evaluates the newest |
| `alerts.js` | Incident state machine (dedup, resolve streak, cooldown) |
| `notifiers/` | Fan-out sinks; failures isolated per sink |
| `store.js` | Durable incident history, atomic debounced writes |
| `server.js` | HTTP API + Prometheus exposition |

Adding a source means implementing `collect()` and registering it in
`sources/index.js`; nothing else changes.

## Detection pipeline

1. **Baseline** — oldest `baselineWindows` entries give mean μ and σ per metric.
   σ is floored (`sigmaFloorRatio`, and optionally `sigmaFloorAbs`) so a quiet
   baseline cannot manufacture enormous z-scores.
2. **Normalize** — `z = (x − μ) / σ`.
3. **Qualify** — `z ≥ zThreshold` sustained for `minSustain` consecutive
   windows. Single-window spikes are discarded.
4. **Score** — `R = mean_z(qualified) × ln(1 + signal_count) × W`.
5. **Trigger** — `R ≥ triggerThreshold` opens an incident.

The logarithm is the point: risk grows with the *number of converging signals*,
so three metrics at 3σ outrank one metric at 9σ.

## Design decisions

**Zero runtime dependencies.** The agent uses only Node stdlib — `node:http`,
`fetch`, `node:fs/promises`. No supply chain to audit, no install step in the
container, and the whole thing stays readable. The AWS SDK is imported lazily
by the CloudWatch source alone, so only AWS users pay for it.

**Rolling baseline, not a fixed one.** Services legitimately change behaviour;
a frozen baseline would alert forever after a deploy. The cost is that an
incident lasting longer than `historyWindows` is eventually absorbed into its
own baseline — documented, tunable, and the right trade for request-path
services.

**Detection state is persisted, but only trusted while it is fresh.** Both the
rolling buffers and the incident lifecycle are written to the JSON store — on a
schedule (`storage.snapshotEveryTicks`) and once on clean shutdown — and
restored at startup. Without this, every restart costs a full warm-up, and an
incident in flight would re-open and page twice. The guard is staleness:
`storage.restoreMaxAgeSeconds` (default 900) discards state older than that,
because a baseline built from hour-old samples no longer describes the service.
Set it to `0` to always warm up fresh.

**Missing is not zero.** A sample is buffered only if every configured metric is
present and finite; otherwise it is rejected whole and counted as an incomplete
sample. Coercing a missing metric to `0` would manufacture an observation — a
lost error-rate series would read as a perfect 0% error rate, suppress the
convergence requirement, and pull the rolling baseline toward a value nothing
ever measured. `/health` reports `degraded` once no valid telemetry has arrived
for `detector.noDataGraceSeconds` (default 300), so a silent exporter failure
looks like a failure rather than a quiet night.

**One incident per cascade.** Alerting per window is how monitoring gets muted.
The state machine plus cooldown is as much of the product as the math.

**The API is authenticated, and refuses to be exposed without it.** A bearer
token is read from `FAULTLINE_API_TOKEN` (with an optional read-only token in
`FAULTLINE_READ_TOKEN`), never from a config file. Unauthenticated operation is
permitted only on a loopback bind. Binding anywhere else without a token makes
the agent refuse to start, because the API can create silences and inject
faults, and a warning that does not stop the request is not a control.

## Dashboard

React + Vite, importing `@faultline/core` directly, so all detection runs
client-side. It ships a curated 12-window cascade for exploring the math, a CSV
panel for arbitrary telemetry, counterfactual mitigation replay, and a
lead-time comparison against static-SLO and single-metric detectors. It is an
analysis and teaching surface; the agent is what runs in production.

## Serverless variant

`backend/lambda/timelineHandler` serves stored detection windows from DynamoDB
(following `LastEvaluatedKey`, so a long timeline is not silently truncated) and
can serve live API Gateway metrics from CloudWatch.

At the window where detection fired it can call Amazon Bedrock for a plain-language
summary, behind a 2.5s timeout with a deterministic fallback. The summary is
constrained in both directions: the prompt states that no dependency graph,
traces, or deploy history are available and forbids naming any service other
than the one evaluated, and the response is rejected unless it names that same
service and carries three evidence strings that each cite a qualified metric.
Accepted output is tagged
`generated_by: "bedrock"` with its `model_id` and `scope: "single_service_drift"`,
so no consumer can present it as cross-service causality. It is the reference for
adding an LLM explanation layer without letting the model influence detection.

The live CloudWatch path reports gaps rather than filling them: a minute with no
datapoint for any metric is omitted from `raw` and counted in `data_quality`.
Its 4XX-derived series is named `client_error_rate`, not `retry_rate` — API
Gateway's `4XXError` counts every client-side error, including auth failures and
malformed requests, and is not a retry counter.

It is deployed from `template.yaml` (SAM), which parameterises every
account-specific value, and packaged reproducibly by `npm run package`.

## Testing

| Suite | Tests | Covers |
|---|---:|---|
| `packages/core/test` | 34 | Baseline math, qualification, risk scoring, counterfactuals, CSV parsing |
| `packages/agent/test` | 180 | Config and effective-profile validation, ring buffer, incident state machine, every source, HTTP API, auth and exposure defaults, no-data handling, shutdown, end-to-end runs |
| `packages/benchmark/test` | 29 | Scenario generation, segment scoring, rolling vs fixed-baseline detectors, SMD backtest helpers |
| `frontend/dashboard/test` | 21 | Hypothesis provenance labelling, cascade-path parsing, analyst rendering |
| `backend/lambda/timelineHandler/test` | 23 | Mocked DynamoDB (incl. pagination), CloudWatch gaps, Bedrock success/timeout/malformed/fallback, error handling |
| `scripts/verifyEngine.mjs` | — | Reference cascade reproduces and beats baseline detectors |

**287 tests total**, as of 2026-08-11. The Lambda suite is separate because the
Lambda has its own lockfile and is installed independently; `npm test` at the
root covers the other four. These counts are maintained by hand — re-run both
suites before quoting them.

The end-to-end test runs a full agent against an injected cascade and asserts
that exactly one alert fires, reaches a real webhook receiver, persists to
disk, and resolves — plus that a dead webhook and a dead source degrade
gracefully instead of taking the agent down.

CI runs all of it across six jobs:

| Job | What it proves |
|---|---|
| `verify` | Lint, all four workspace suites, reference scenario, benchmark, agent smoke test, dashboard build |
| `lambda` | The handler installs from its own lockfile, imports with only its declared dependencies, passes its mocked suite, packages into an artifact, and its SAM template lints |
| `security-defaults` | The agent refuses to start unauthenticated on a non-loopback bind, and compose publishes to loopback only |
| `audit` | Every independent lockfile is audited; production dependencies must be clean |
| `backtest` | A bounded real-telemetry backtest (one SMD machine, 10-sample windows) completes inside a 10-minute budget |
| `docker` | The image refuses to start without a token, starts with one, serves `/health`, and rejects an anonymous silence with 401 |
