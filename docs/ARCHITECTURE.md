# FAULTLINE Architecture

FAULTLINE detects cascade failures in distributed systems by scoring how
telemetry signals converge over time. It ships as three pieces that share one
detection engine.

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

**Detection state is not persisted; incidents are.** Resuming a rolling buffer
from hours-old samples would produce a baseline that no longer describes the
service. Warming up again after restart is the safer default.

**One incident per cascade.** Alerting per window is how monitoring gets muted.
The state machine plus cooldown is as much of the product as the math.

**The API is unauthenticated by design.** It is intended for localhost or a
private network, behind existing ingress/auth. Building a half-authentication
scheme would invite it to be exposed.

## Dashboard

React + Vite, importing `@faultline/core` directly, so all detection runs
client-side. It ships a curated 12-window cascade for exploring the math, a CSV
panel for arbitrary telemetry, counterfactual mitigation replay, and a
lead-time comparison against static-SLO and single-metric detectors. It is an
analysis and teaching surface; the agent is what runs in production.

## Serverless variant

`backend/lambda/timelineHandler` serves stored windows from DynamoDB and, at
detection, calls Amazon Bedrock (Claude) for a structured root-cause hypothesis
— root service, mechanism, cascade path, evidence — behind a strict timeout
with a deterministic fallback. It is the reference for adding an LLM
explanation layer without letting the model influence detection.

## Testing

| Suite | Covers |
|---|---|
| `packages/core/test` | Baseline math, qualification, risk scoring, counterfactuals, CSV parsing |
| `packages/agent/test` | Config validation, ring buffer, incident state machine, every source, HTTP API, end-to-end runs |
| `scripts/verifyEngine.mjs` | Reference cascade reproduces and beats baseline detectors |

The end-to-end test runs a full agent against an injected cascade and asserts
that exactly one alert fires, reaches a real webhook receiver, persists to
disk, and resolves — plus that a dead webhook and a dead source degrade
gracefully instead of taking the agent down.

CI runs all of it, plus a Docker build that boots the container and polls
`/health`.
