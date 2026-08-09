# Contributing to FAULTLINE

Thanks for considering it. Issues, questions and pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/Harshith029/faultline.git
cd faultline
npm install
npm test
```

Node 20 or newer. The agent and engine have **no runtime dependencies** and the
test suite uses Node's built-in runner, so there is nothing else to install.

```bash
npm test                 # 169 unit and integration tests
npm run verify:engine    # reference cascade assertion
npm run benchmark        # precision/recall against baseline detectors
npm run agent:demo       # watch the agent detect a live synthetic cascade
npm run build            # build the optional dashboard
```

## Repository layout

```
packages/core/       detection engine + CSV parser (zero deps, shared)
packages/agent/      the monitoring agent: sources, detector, alerting, API
packages/benchmark/  labeled benchmark + real-data backtest harness
frontend/dashboard/  incident-analysis UI (optional)
docs/                architecture, operations, backtest results
```

## The one invariant

**Detection stays deterministic and auditable. AI may explain a detection; it
must never cause or suppress one.**

Every number the agent reports has to be reproducible by hand from the raw
telemetry. A change that makes detection depend on a model, a heuristic that
cannot be explained, or anything non-reproducible will be declined however well
it performs.

## Changes to detection behaviour

Detection changes are held to a higher bar than everything else, because a
monitoring tool that cries wolf gets muted and then it protects nobody.

If your change affects what fires, include benchmark numbers before and after:

```bash
npm run benchmark
npm run fetch:dataset && npm run backtest   # real telemetry, slower
```

Two things the project has learned the hard way, both documented in
[docs/BACKTEST.md](docs/BACKTEST.md):

- **Compare at matched alert volume.** A change that makes the detector more
  sensitive will look better on recall and worse on precision without improving
  discrimination at all. Hold alert volume roughly constant, then compare.
- **Report per subject, not just aggregate.** One rejected change improved
  aggregate F1 by 21% while sending one machine in four completely blind. When
  monitoring fails it fails on *your* system, not the average one.

Ideas that lose on measurement are documented and removed rather than left in
the codebase behind a flag. Three have been rejected this way so far; a
well-measured negative result is a genuinely welcome contribution.

## Style

- Match the surrounding code. No formatter is enforced.
- Comments explain *why*, not *what*. Most code needs none.
- Tests are required for behaviour changes. Prefer a test that would have
  caught the bug over one that restates the implementation.
- Keep the agent dependency-free. A new runtime dependency needs a strong
  argument; the zero-dependency property is a feature, not an accident.

## Pull requests

1. Branch from `main`.
2. Make sure `npm test` and `npm run verify:engine` pass.
3. Describe what changed and why. If it touches detection, include the numbers.
4. Small, focused PRs get reviewed faster than large ones.

## Reporting bugs

Include the agent version, your config with secrets removed, relevant log lines
(the agent logs structured JSON), and what you expected instead. If it concerns
detection quality, a CSV of the telemetry involved is the single most useful
thing you can attach — the engine will run on it directly.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
