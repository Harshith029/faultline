# Deploying the timeline handler

> **Legacy.** This Lambda is the project's original backend, from the v1
> competition entry, and predates the agent. The product is the
> zero-dependency Node.js agent (`packages/agent`) and the dashboard, and
> neither needs this API. It is kept because the dashboard's optional live mode
> (built with `VITE_API_URL`) reads from it, and its tests run as part of the
> root `npm test`.

This package is deliberately **outside the root npm workspaces**. It has its own
lockfile and is installed, tested, and packaged independently, so the deployment
artifact contains exactly the dependencies the handler declares and nothing from
the dashboard or agent trees.

## What it serves

| Request | Behaviour |
|---|---|
| `GET /timeline?service_id=B` | Detection windows for one service from DynamoDB, paginated via `LastEvaluatedKey` |
| `GET /timeline?source=live` | Live API Gateway metrics from CloudWatch, last 60 one-minute windows |

At the window where detection fired, the handler can call Bedrock for a
plain-language summary. This is optional: leave `BedrockModelId` empty and it
always serves the deterministic `hypothesis_fallback` stored alongside the
window.

The explanation for a given service, window and model is cached inside a warm
Lambda container, because the stored timeline does not change between requests:
successes for `HYPOTHESIS_CACHE_SECONDS` (default 900), failures for 60 seconds
so a broken model is not called in a loop. The cache is per container, so a cold
start or a second concurrent container calls the model again. A model call that
exceeds its 2.5 s budget is aborted, not left running in the background.

## Local verification

```bash
npm ci
```

```bash
npm test
```

The suite uses injected fake AWS clients, so it needs no credentials and makes
no network calls. It covers DynamoDB pagination and failure, CloudWatch gaps and
denial, and Bedrock success, timeout, malformed output, and schema rejection.

## Building the artifact

```bash
npm run package
```

Produces `dist/function.zip` from a clean `npm ci --omit=dev` install, verifies
that the handler imports from the staged tree, and prints the byte size and
SHA-256. Nothing is deployed from a hand-built or stale zip; CI builds this on
every run and uploads it.

## Validating the template

```bash
npm run lint:iac
```

Run from the repository root. It reports which Python interpreter it used.
Error and warning findings fail the check. Informational findings (cfn-lint's
I-series rules) are printed as `note:` lines but do not fail it, matching
cfn-lint's own default — new advisory rules ship regularly and should not break
the build on their own.

cfn-lint is a Python tool and its console script is often not on `PATH` — pip
installs it against one interpreter while the shell resolves `python` to another
(a virtualenv, the Windows Store shim, a tool-managed runtime). The wrapper tries
each candidate in turn, and if none has cfn-lint it exits non-zero with
`UNAVAILABLE` rather than reporting success. Override with
`CFN_LINT_PYTHON=/path/to/python npm run lint:iac`.

## Deploying

Every account-specific value in `template.yaml` is a parameter. Nothing is
hard-coded to an account, region, or pre-existing resource.

```bash
sam deploy --guided --template template.yaml
```

| Parameter | Default | Notes |
|---|---|---|
| `ApiAuthMode` | **none — you must choose** | `iam`, `api-key`, or `none`. See below |
| `TableName` | `Faultline-DriftSignals` | DynamoDB table holding precomputed windows |
| `CreateTable` | `true` | Set `false` to attach to an existing table |
| `BedrockModelId` | *(empty)* | Empty disables Bedrock entirely; the fallback is always served |
| `LiveApiName` | *(empty)* | Empty disables `?source=live`; otherwise the API Gateway `ApiName` dimension |
| `CorsAllowOrigin` | `'*'` | Quote the value. It answers preflights and, passed to the function as `CORS_ALLOW_ORIGIN`, every actual response too. `*` is for a public read-only demo only; CORS decides which pages may read a response, it is not access control |
| `LogRetentionDays` | `14` | CloudWatch Logs retention |

### Choosing `ApiAuthMode`

`ApiAuthMode` has **no default on purpose**. `sam deploy --guided` prompts for
it and `aws cloudformation deploy` fails without it, so a stack cannot reach an
account without someone deciding who may call the API.

| Mode | What it does | Cost of choosing it |
|---|---|---|
| `iam` | Requires SigV4-signed requests | Callers need AWS credentials; the dashboard cannot call it as-is |
| `api-key` | Requires `x-api-key`; creates a usage plan with a 10,000/day quota | The key must be distributed to callers; a browser bundle cannot hold one secretly |
| `none` | Open to the internet | Anyone can read your detection history |

**`ApiAuthMode=none` with `BedrockModelId` set is refused at deploy time.** In
that configuration any anonymous caller could drive billed model invocations,
and throttling (20 burst / 10 rps) plus the per-container cache only bound the
rate; they do not prevent it. The template's `NoBedrockOnAnonymousApi` rule
fails the deploy before any resource is created. For a Bedrock-enabled stack,
the `api-key` usage plan (10,000 requests a day) is the spend bound. The stack
still outputs `ApiAuthModeOut` and `BedrockEnabled`, so the configuration in
force is visible after deploy.

The dashboard sends unauthenticated `fetch` calls today
(`frontend/dashboard/src/timelineApi.js`). Picking `iam` or `api-key` therefore
requires a corresponding change there — a signing proxy, a CloudFront function,
or a backend-for-frontend. That work is not in this repository, and the right
shape depends on how you intend to host the dashboard. The API CORS policy
permits `Authorization` and `X-Api-Key` headers for such a client; it does not
make a browser-embedded key secret.

The stack grants only what the enabled features need: `dynamodb:Query` on the one
table, `bedrock:InvokeModel` on the one model (only when `BedrockModelId` is set),
and `cloudwatch:GetMetricData` scoped by the `AWS/ApiGateway` namespace condition
key (only when `LiveApiName` is set). `GetMetricData` has no resource-level ARN,
which is why it is constrained by condition rather than by resource.

`iam-policy.json` at the repository root is the equivalent policy for a
hand-managed role. Prefer the template.

### Table schema

If you set `CreateTable=false`, the existing table must use:

- Partition key `service_id` (String)
- Sort key `window_number` (Number)

Items are expected to carry `window_timestamp`, `metrics`, `qualified_signals`,
`signal_count`, `R_score`, `confidence`, `triggered`, `outage`, and
`hypothesis_fallback`.

## Wiring up the dashboard

The stack output `ApiUrl` is what the dashboard expects:

```bash
VITE_API_URL=https://<id>.execute-api.<region>.amazonaws.com/prod
```

The dashboard never calls the API on page load. The scenario's explanation is
sample text until someone clicks **Load API explanation**, and live mode is
fetched only when selected, so opening the page cannot cause a model call.

## Notes on the live path

`client_error_rate` is API Gateway's `4XXError`, which counts every client-side
error — auth failures, malformed requests, throttling. It is **not** a retry
counter, and an earlier version of this handler called it `retry_rate`, which
asserted a causal story the metric cannot support.

Minutes with no datapoint are omitted from `raw` and reported in `data_quality`
rather than being filled with zeros. A fabricated `0 ms` latency is
indistinguishable from a genuinely idle service, and would be folded into the
detector's baseline as if it had been observed.

`window_number` in `raw` is the minute's slot in the hour (1–60), not its
position among complete rows, so a missing minute shows as a jump; the response
also carries `window_seconds: 60`. Earlier versions renumbered the complete
rows 1, 2, 3…, which made minutes either side of a hole look adjacent and let a
sustained run span missing data. The dashboard runs the engine with
`windowSeconds`, so adjacency is checked against the timestamps as well.

## Runtime

The function runs on `nodejs22.x`, and the CI `lambda` job tests on Node 22 to
match. Node 22 leaves security support in April 2027; move both to
`nodejs24.x` / Node 24 before then.
