# ⚡ FAULTLINE
### AI Reliability Intelligence for Distributed Systems

> **FAULTLINE is an AI reliability engineer that watches your distributed systems continuously — detecting failure patterns as they form, reasoning about root causes, predicting cascade trajectories, and telling your team exactly what to do before users are affected.**

**Live Demo:** https://production.d1zk8ptor0c0s.amplifyapp.com/

---

> ⚠️ **This repository is a showcase of FAULTLINE v1.**
> The source code is published for visibility and collaboration interest only.
> Commercial use, copying, modification, and redistribution are not permitted.
> See [Licence](#licence) for details.
>
> **Interested in collaborating, investing, or building on this?**
> Reach out: [harshith.pali3286@gmail.com](mailto:harshith.pali3286@gmail.com)

---

## The Problem

Modern distributed systems fail gradually, then suddenly.

Latency climbs slightly. Retry rates tick upward. Error signals appear sporadically across services. Individually these look like noise. Together, sustained across multiple time windows, they are the early behavioral signature of a cascade failure forming.

Traditional monitoring misses this entirely. Alerts fire when metrics cross static thresholds — by which point the system is already failing, engineers are already behind, and users are already affected.

The signals were always there. Nobody was reading them.

**FAULTLINE reads them.**

---

## What FAULTLINE Is

FAULTLINE is not a monitoring dashboard with an AI chatbot attached.

It is a system where AI is doing the operational work — continuously watching telemetry, reasoning about system behavior, identifying failure patterns as they form, and advising engineers on what to do before the failure completes.

```
Math    = the nervous system
          Detects signals. Never lies. Never guesses.
          Mathematically reproducible. Fully auditable.

AI      = the brain
          Understands what signals mean.
          Reasons about failure mechanisms.
          Predicts cascade trajectories.
          Tells engineers what is coming and what to do.

Engineer = the hands
           Takes action based on what the brain says.
           Faster. More informed. Before users notice.
```

The detection foundation is deterministic — z-score drift math, signal qualification, cascade risk scoring. The intelligence layer built on top of it does what a senior SRE does during an incident: reads the signals, understands the system, predicts the trajectory, and tells the team what to do. The difference is FAULTLINE does it automatically, at the moment patterns begin forming, not after users start complaining.

In production with real telemetry history, FAULTLINE identifies instability patterns **weeks before they escalate** into incidents — because cascade failures do not appear overnight. They form through gradual behavioral drift that accumulates over time. A service that will fail catastrophically next month is already showing subtle signal drift today.

---

## How Detection Works

### Z-Score Normalization
```
z = (value - mean) / standard_deviation
```
Every telemetry signal is normalized against its historical baseline — making signals from different services and metrics comparable on the same scale.

### Signal Qualification
```
z >= 2.0  AND  persists for >= 2 consecutive windows
```
Single-window spikes are ignored. Only sustained drift qualifies. This eliminates false positives from transient noise.

### Cascade Risk Scoring
```
R = mean_z × ln(1 + signal_count) × W
```
- `mean_z` — average drift intensity across qualified signals
- `signal_count` — number of converging signals
- `W` — service criticality weight

### Detection Trigger
```
R >= 3.0  →  cascade failure pattern detected
```
When triggered, Amazon Bedrock generates a structured root cause hypothesis from the actual signal data.

---

## What AI Does in FAULTLINE

### Continuous System Intelligence (Every Window)
AI does not wait for detection. It is present at every telemetry window — watching signal trajectories, identifying feedback loops forming, and advising engineers throughout the entire incident lifecycle:

- **W1–W4:** System nominal → directional trends forming. AI identifies early drift and predicts signal qualification timing.
- **W5–W6:** First signals qualify. AI names the failure mechanism forming (retry amplification, connection pool pressure) and recommends pre-emptive action before the cascade locks in.
- **W7:** Two signals converging. AI warns: trigger imminent. Acting now prevents the outage entirely.
- **W8:** Detection fires. AI diagnoses root cause, maps the cascade path across service dependencies, and prescribes remediation steps ranked by impact.
- **W9–W12:** AI tracks cascade trajectory, updates blast radius assessment, and guides recovery.

### Root Cause Diagnosis (Amazon Bedrock)
At detection, Amazon Bedrock Claude Haiku receives the full signal context and generates a structured diagnosis:
- **Root service** — which service is the origin
- **Failure mechanism** — what is happening inside the system
- **Cascade path** — how the failure propagates across dependencies
- **Evidence** — three specific observations from the actual telemetry data

Real inference on real data. Not a template.

### Incident Intelligence
Engineers ask questions. FAULTLINE answers from the incident data — blast radius, remediation priority, what-if scenarios, architectural vulnerability analysis. Every answer is grounded in the actual signal values from the current incident.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   FAULTLINE v1 — AWS ARCHITECTURE             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  S3 (faultline-datasets)                                     │
│    └── Simulation telemetry dataset                          │
│                    ↓                                         │
│  DynamoDB (Faultline-DriftSignals)                           │
│    └── Time-series telemetry windows                         │
│        PK: service_id | SK: window_timestamp                 │
│                    ↓                                         │
│  Lambda (Faultline-TimelineHandler, Node 20.x)               │
│    ├── Deterministic drift detection                         │
│    ├── Cascade risk scoring                                  │
│    └── Bedrock Claude Haiku invocation at trigger            │
│                    ↓                                         │
│  API Gateway (GET /timeline, prod stage, CORS enabled)       │
│                    ↓                                         │
│  React Dashboard (AWS Amplify)                               │
│    ├── AI Insight Panel     continuous intelligence layer    │
│    ├── Hypothesis Card      Bedrock root cause analysis      │
│    ├── Architecture Map     cascade visualization            │
│    ├── Incident Chat        engineer intelligence interface  │
│    └── 10 visualization components                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### AWS Services Used
| Service | Role |
|---------|------|
| Amazon DynamoDB | Telemetry window storage |
| AWS Lambda | Detection engine + AI orchestration |
| Amazon API Gateway | REST API |
| Amazon S3 | Dataset storage |
| Amazon Bedrock (Claude 3 Haiku) | Root cause hypothesis generation |
| AWS Amplify | Frontend hosting + CDN |
| Amazon CloudWatch | Observability and logging |

**Region:** ap-south-1 (Mumbai)

---

## The Demo

Open the live dashboard and drag the scrubber across 12 windows to watch a cascade failure form, be detected, and reach outage.

| Window | What You See |
|--------|-------------|
| W1–W2 | System nominal. AI confirms baseline. |
| W3 | AI flags directional trend in p99 latency. |
| W4 | Threshold crossed. AI predicts Signal 1 imminent. |
| W5 | Signal 1 qualified. AI identifies connection pool pressure. |
| W6 | AI names the retry amplification loop as it forms. Recommends pre-emptive action. |
| W7 | Two signals converging. AI warns: trigger imminent within 1 window. |
| W8 | ⚡ Detection fires. Bedrock diagnosis appears. Architecture map shows cascade B→D→F. |
| W9–W11 | Cascade deepening. AI tracks trajectory. Recovery guidance active. |
| W12 | ⚠ Outage confirmed. Detected 4 windows ago. |

**Live Demo:** https://production.d1zk8ptor0c0s.amplifyapp.com/

---

## v1 Status

This is FAULTLINE v1 — a working prototype that demonstrates:

- ✅ Deterministic cascade detection on simulated telemetry
- ✅ Amazon Bedrock AI reasoning at detection moment
- ✅ Continuous AI intelligence narration across all 12 windows
- ✅ Interactive cascade visualization
- ✅ Full AWS serverless deployment
- ✅ Engineer incident intelligence interface

Built as part of the **AWS Builder Center AIdeas Challenge — Top 1000 Semi-Finalist** by Team Progsolve.

---

## v2 Roadmap

v2 expands AI from observing and explaining to actively working on the system:

**Phase 1 — Live AI Chat**
Real Bedrock inference on every engineer question with full incident context injected automatically.

**Phase 2 — Real Telemetry Ingestion**
CloudWatch → Kinesis → Lambda pipeline. Live metrics from real services. Multiple services monitored simultaneously.

**Phase 3 — Proactive AI Advisor**
AI stops waiting to be asked. Scheduled assessments pushed to engineers before detection fires:
> "Watching service-b. Retry amplification forming. Recommend circuit breaking now."

**Phase 4 — Adaptive Thresholds**
Per-service dynamic detection thresholds computed from rolling 30-day baselines. AI calibrates sensitivity automatically.

**Phase 5 — Predictive Failure Modeling**
LSTM model predicts failure probability for the next N windows. Estimated time-to-failure. AI sees failure coming before the detection threshold is reached.

**Phase 6 — Correlation Engine**
X-Ray trace ingestion builds a live dependency graph. Blast radius calculated from real service topology.

**Phase 7 — Continuous Learning**
Engineer feedback trains the pattern library. System improves with every incident it processes.

```
v1:  AI watches + narrates + explains + advises
v2:  AI predicts + adapts + proactively intervenes + learns
v3:  AI understands your system better than any single engineer
```

---

## Research Directions

FAULTLINE opens three research questions:

**Hybrid Detection Architecture**
Where is the right boundary between statistical detection and learned models in production reliability systems? FAULTLINE formalizes this boundary — making it auditable and trustworthy — rather than blurring it as most hybrid systems do.

**Explainable Reliability Engineering**
Every FAULTLINE alert comes with a natural language explanation of why it fired, what the failure mechanism is, and what to do. XAI applied to SRE at the moment it is most needed.

**Temporal Signal Convergence**
Traditional anomaly detection treats metrics independently. FAULTLINE analyzes how signals interact and converge across time. The convergence pattern — not the individual metric threshold — is the detection signal.

---

## Interested in This Project?

FAULTLINE is actively being developed toward a full production reliability intelligence platform.

If you are:
- An engineer who wants to contribute to v2
- A researcher working on distributed systems, AIOps, or MLOps
- A company looking to build or integrate predictive reliability tooling
- An investor interested in the AI infrastructure space

**Get in touch:** [harshith.pali3286@gmail.com](mailto:harshith.pali3286@gmail.com)

---

## Support This Project

FAULTLINE was built as part of the **AWS Builder Center AIdeas Challenge** 
and published as a showcase of what AI-native reliability tooling can look like.

If this project resonates with you, here is how you can support it:

### ⭐ Star this repository
Helps others discover the project and signals that this problem space matters.

### 📖 Read the full project article on AWS
The complete story of how FAULTLINE was designed, built, and deployed — 
including the architecture decisions, the AI reasoning layer, and the roadmap.

👉 [Read the FAULTLINE article on AWS Builder Center](https://builder.aws.com/content/3AuBMFpv22Kue07Q8ZxD0n1GJGD/aideas-faultline-ai-assisted-predictive-reliability-intelligence-for-distributed-systems)

### 👍 Like and comment on the article
If you found the approach interesting — the hybrid detection architecture, 
the AI intelligence layer, the sacred boundary between math and AI — 
leaving a like or comment on the AWS article helps the project reach more 
engineers and researchers who are working on similar problems.

### 💬 Leave your thoughts
Have feedback on the architecture? Ideas for v2? 
Seen a similar problem in your own infrastructure?

Open a GitHub Discussion or reach out directly:
📧 [harshith.pali3286@gmail.com](mailto:harshith.pali3286@gmail.com)

Every piece of feedback — technical critique, use case suggestions, 
research connections — directly shapes where FAULTLINE goes next.

---

## Licence

Copyright © 2026 Harshith Pali / Progsolve. All Rights Reserved.

This repository is published for portfolio and collaboration visibility only.

You may view and reference this code for personal learning purposes.

You may **not**:
- Use this code or any portion of it in commercial products or services
- Copy, modify, merge, publish, or distribute this code
- Use this project's concepts, architecture, or implementation in competing products without written permission

For licensing inquiries or collaboration proposals, contact: harshith.pali3286@gmail.com