# Dependency posture

Faultline has four independent dependency trees. A root-only `npm audit` misses
three of them, so each is audited separately in CI.

| Tree | Lockfile | Audited by |
|---|---|---|
| Workspaces (core, agent, benchmark, dashboard) | `package-lock.json` | `audit` job, root step |
| Lambda timeline handler | `backend/lambda/timelineHandler/package-lock.json` | `audit` job, Lambda step |
| Dataset/build scripts | `scripts/package-lock.json` | `audit` job, scripts step |
| Docker image | built from the agent workspace | `docker` job |

## Current status

Last reviewed: 2026-11-19.

**No known advisories in any tree, at any severity** — production and
development alike:

```bash
npm run audit:all
```

The November review cleared what had accumulated since August: Vitest 3 → 5
(the critical tinypool and `@vitest/mocker` advisories; a major-version
upgrade), Vite 8.3.8 (past the 8.2.0–8.2.2 `launch-editor` advisory), patched
transitive `brace-expansion`, `browserslist`, `js-yaml`, `picomatch`,
`source-map-js`, `postcss-selector-parser` and `baseline-browser-mapping`, and in
the Lambda tree `fflate` 0.8.3 via `@smithy/middleware-compression` 4.6.2. That
last one is a ZIP64 parsing loop in a function the handler never calls; it was
updated regardless, because "unreachable today" is not a property anyone
re-checks.

The agent itself has no required runtime dependencies beyond `@faultline/core`.
The AWS SDK is an optional lazy import used only by the `cloudwatch` source.

## Accepted exceptions

None at present.

The picomatch ≤ 2.3.1 exception recorded in August (GHSA-3v7f-55p6-f55p,
GHSA-c2c7-rcm5-vvqj, via `tailwindcss@3.4.17 → chokidar/micromatch`) is
resolved: picomatch 2.3.2 shipped the fixes within the 2.x line that
`micromatch@4` accepts, so the Tailwind 4 migration is no longer needed for it.

## CI policy

The `audit` job enforces:

- **Production dependencies must be clean** at every severity, for every tree.
  This step fails the build. The Lambda and scripts trees have no development
  dependencies, so each is held to this whole.
- **Development dependencies** are audited at `--audit-level=high` and reported.
  This step does not fail the build, because a dev-only advisory should not
  block a security fix from shipping — but its output is always printed, and any
  new entry must be either fixed or added to *Accepted exceptions* above with a
  reachability assessment.

Audit output is never suppressed with `--force`, `npm audit --ignore`, or by
deleting the step.

## Re-running locally

```bash
npm audit --omit=dev --audit-level=low
```

```bash
npm --prefix backend/lambda/timelineHandler audit --omit=dev --audit-level=low
```

```bash
npm --prefix scripts audit --omit=dev --audit-level=low
```
