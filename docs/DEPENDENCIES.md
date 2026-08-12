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

Last reviewed: 2026-08-10.

**Production dependencies: no known advisories.**

```bash
npm audit --omit=dev --audit-level=low
```

reports zero vulnerabilities at the root, and both the Lambda and scripts trees
report zero at all severities.

The agent itself has no required runtime dependencies beyond `@faultline/core`.
The AWS SDK is an optional lazy import used only by the `cloudwatch` source.

## Accepted exceptions

### picomatch ≤ 2.3.1 — high — development only

- **Advisories:** GHSA-3v7f-55p6-f55p (method injection in POSIX character
  classes), GHSA-c2c7-rcm5-vvqj (ReDoS via extglob quantifiers).
- **Path:** `tailwindcss@3.4.17 → chokidar/micromatch → picomatch@2.3.1`.
- **Reachability:** not reachable in any shipped artifact. Tailwind uses
  picomatch at build time to match the `content` globs in
  `tailwind.config.cjs`, which are authored in this repository and are not
  attacker-controlled. picomatch is not present in the browser bundle, the agent
  runtime, or the Lambda artifact. Triggering either advisory requires the
  ability to supply a glob pattern to the CSS build, which means the attacker
  already has commit access.
- **Why not updated:** `micromatch@4` requires `picomatch@^2.3.1`. An override
  forcing v4 changes the API surface micromatch depends on. The real fix is
  Tailwind 4, which moves to a new engine and requires a config and directive
  rewrite.
- **Remediation:** tracked as a Tailwind 4 migration. Until then the exception is
  bounded by the CI policy below.

## CI policy

The `audit` job enforces:

- **Production dependencies must be clean** at every severity, for every tree.
  This step fails the build.
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
npm --prefix backend/lambda/timelineHandler audit --audit-level=high
```

```bash
npm --prefix scripts audit --audit-level=high
```
