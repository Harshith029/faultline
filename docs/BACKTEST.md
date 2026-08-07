# Backtest on real production telemetry

Everything else in this repository measures FAULTLINE against scenarios this
project designed. This document measures it against telemetry it did not.

**Headline: on real data, FAULTLINE beats every baseline tested — and is still
not precise enough to page a human unattended.** Both halves of that sentence
matter.

## Dataset

The [Server Machine Dataset](https://github.com/NetManAIOps/OmniAnomaly) (SMD),
published with OmniAnomaly (MIT): 28 days of real server telemetry from a large
internet company, 38 channels per machine, sampled once per minute, with
anomaly windows labelled by the operators who ran the systems.

The data is **not vendored here**. `npm run fetch:dataset` downloads it into a
gitignored directory so provenance and licence stay with its authors.

Four machines were used: `machine-1-1`, `machine-1-2`, `machine-2-1`,
`machine-3-2` — 41 labelled incidents across ~19,900 detection windows.

## Protocol

- Raw samples are aggregated into **5-minute windows** (mean per channel). A
  window is labelled anomalous if any sample inside it was.
- Detection is **replayed causally**: at each window a detector sees only the
  preceding 120 windows. Nothing can see the future.
- **All 38 channels are used as the metric set.** No channel was hand-picked to
  favour the method — this is the metric-agnostic engine running on whatever the
  machine emitted.
- Because SMD is normalized to roughly 0..1 and many channels are near-constant,
  an absolute sigma floor of 0.01 is applied **identically to every detector**,
  otherwise a flat channel produces infinite z-scores.
- **Segment-wise scoring**, the convention in this literature and the one that
  matches how operators experience alerts: an incident is caught if a detector
  fires anywhere inside it, and a contiguous run of firing outside any incident
  is one false positive. Firing every minute of a two-hour outage is one alert,
  not a hundred.

Reproduce with:

```bash
npm run fetch:dataset
npm run backtest
```

## Results

Aggregate across 4 machines, 41 labelled incidents:

| Detector | Precision | Recall | F1 | False alerts |
|---|---:|---:|---:|---:|
| **FAULTLINE** | **14.1%** | 80.5% | **23.9%** | 544 |
| Sustained 3σ | 11.3% | 85.4% | 20.0% | 430 |
| Single metric 3σ | 7.3% | 97.6% | 13.5% | 1019 |

FAULTLINE has the best F1 and raises precision by ~2× over a single-metric
threshold while nearly halving its false alerts. The ordering matches the
synthetic benchmark. The *magnitudes* do not.

Per machine, the picture is uneven:

| Machine | FAULTLINE F1 | Sustained 3σ F1 | Single 3σ F1 |
|---|---:|---:|---:|
| machine-1-1 | **51.6%** | 23.4% | 20.0% |
| machine-1-2 | 11.7% | **14.1%** | 10.0% |
| machine-2-1 | 23.1% | **31.8%** | 13.8% |
| machine-3-2 | **20.7%** | 15.8% | 13.4% |

FAULTLINE wins on two machines and loses on two. On `machine-1-1` it is
decisively better (51.6% vs 23.4%); on `machine-2-1` the far simpler sustained
threshold beats it.

## The synthetic benchmark overstated real performance by ~6×

| Suite | Precision | Recall |
|---|---:|---:|
| Synthetic scenarios (`npm run benchmark`) | 83.3% | 100% |
| Real telemetry (`npm run backtest`) | 14.1% | 80.5% |

This is the single most important number in the project. The synthetic suite was
built from the same mental model as the detector — cascades that ramp, converge,
and sustain — so it largely measures whether the implementation matches its own
assumptions. It is useful as a regression test. It is **not** evidence of field
performance, and it is now labelled as such in the README.

## Tuning does not rescue it

The obvious hypothesis for the false positives was that requiring only 2 of 38
channels to converge is far too weak: 2/3 metrics agreeing is meaningful, 2/38 is
5%. A parameter sweep (`npm run backtest -- --sweep`) refutes this:

| minSignals | trigger | Precision | Recall | F1 |
|---:|---:|---:|---:|---:|
| 2 | 3 | 14.1% | 80.5% | 23.9% |
| 2 | 8 | 16.5% | 68.3% | **26.5%** |
| 4 | 8 | 16.0% | 65.9% | 25.8% |
| 6 | 3 | 13.3% | 65.9% | 22.1% |
| 8 | 3 | 12.3% | 58.5% | 20.3% |
| 12 | 3 | 8.7% | 34.1% | 13.8% |

Precision never exceeds ~16.5% at any setting, and demanding more converging
signals *reduces* it while destroying recall. The false positives are therefore
not coincidental agreement between unrelated channels — they are real,
multi-channel, sustained excursions in the telemetry that operators did not
label as incidents. Deploys, batch jobs, traffic shifts and capacity changes all
look exactly like the leading edge of a cascade.

**This is a property of the problem, not a bug in the implementation.** A
detector that alerts on sustained multi-signal drift will alert on every
sustained multi-signal drift, and most of them are not incidents.

## What this means for using FAULTLINE

Honestly stated:

- **Do not wire it directly to a pager on a broad, unfiltered metric set.** At
  14% precision that is roughly six false pages per true one.
- **It is a good ranking and triage signal.** 80% of real incidents are caught,
  with substantially less noise than the thresholds many teams already run.
  Routing it to a dashboard, a Slack channel, or an incident-enrichment pipeline
  is defensible today; routing it to PagerDuty is not.
- **Curated metric sets are where it earns its keep.** `machine-1-1` (F1 51.6%)
  suggests performance is far better where the channels are genuinely coupled.
  Three to six well-chosen, causally related signals should beat 38 arbitrary
  ones — the guidance in [AGENT.md](AGENT.md) on choosing metrics is not
  decoration.
- **The convergence rule is doing real work**, just less than the synthetic
  suite implied: 2× the precision of a single-metric threshold at comparable
  recall.

## Tried and rejected: change-point detection

The roadmap's top item was change-point detection, on the theory that most false
positives are level shifts. It was implemented, measured, and **reverted**.

The implementation rebaselined a metric that had stayed elevated for N windows
and then gone flat (near-zero slope, variance back in family). Measured against
the unchanged detector on the same four machines:

| Detector | Precision | Recall | F1 | False alerts |
|---|---:|---:|---:|---:|
| FAULTLINE | 14.1% | 80.5% | 23.9% | 544 |
| FAULTLINE + change-point | 10.5% | 70.7% | 18.3% | 751 |

Worse on every axis. Two reasons, both instructive:

1. **It fragments episodes.** Rebaselining mid-incident makes the detector
   forget the elevated level; the metric then re-qualifies against the *new*
   baseline as it moves again. One long firing episode becomes several short
   ones, and every extra episode is another alert.
2. **It cannot fire early enough to matter.** Detection triggers at
   `minSustain` (2 windows). Confirming that a shift has *flattened* takes ~8
   windows. The alert has already gone out by the time the change point is
   recognized — on the synthetic suite, `deploy-step-change` still fired on
   100% of runs with the feature enabled.

The second point is the deeper one, and it is not an implementation defect:

> **In the first few windows, a step change and the onset of a cascade are
> genuinely indistinguishable.** Both are "several metrics moved up and stayed
> up". The only way to tell them apart is to wait and see whether the series
> flattens or keeps climbing — and waiting is exactly the lead time this project
> exists to preserve.

Any future attempt has to accept that trade explicitly: either delay alerting to
gain precision, or alert early and accept that some level shifts will page. It
cannot have both. The code was removed rather than shipped disabled-by-default,
because a feature that does not work is a maintenance cost, not an option.

## Tried and rejected: per-channel learned thresholds

Roadmap item 2 was per-channel thresholds, on the theory that one global
`zThreshold` across 38 heterogeneous channels is too crude. Each channel's
threshold was learned from that machine's own **anomaly-free training split**
(the 99.5th percentile of its healthy z-scores, floored at the global default so
learning could only ever raise the bar). Test labels were never consulted.

Aggregate looked like a win:

| Detector | Precision | Recall | F1 | False alerts |
|---|---:|---:|---:|---:|
| FAULTLINE | 14.1% | 80.5% | 23.9% | 544 |
| FAULTLINE + learned thresholds | 20.2% | **51.2%** | 29.0% | **178** |

Two-thirds fewer false alerts and a better F1. Per machine, it falls apart:

| Machine | FAULTLINE F1 | + learned F1 | Recall change |
|---|---:|---:|---|
| machine-1-1 | 51.6% | **61.3%** | 75% → 75% |
| machine-1-2 | 11.7% | **22.7%** | 100% → 90% |
| machine-2-1 | 23.1% | 17.2% | 69% → 46% |
| machine-3-2 | 20.7% | **0.0%** | 80% → **0%** |

On machine-3-2 the detector went **completely blind**: zero of ten incidents
caught, while still emitting 26 false alerts. The aggregate F1 improvement was
hiding a total failure on one machine in four.

The cause is visible in the learned values themselves:

```
machine-1-1  median=8.00  at cap (>=8σ): 20/38 channels   at floor (<=2σ): 15/38
machine-1-2  median=8.00  at cap:        21/38            at floor:         8/38
machine-2-1  median=7.00  at cap:        17/38            at floor:        10/38
machine-3-2  median=8.00  at cap:        19/38            at floor:        10/38
```

Roughly half of every machine's channels saturate the cap. The distribution is
bimodal — floor or cap, little in between — so this is not per-channel
calibration at all; it is a binary "this channel is usable / this channel is
switched off" classifier. On machine-3-2 the channels that actually move during
its incidents landed in the switched-off half.

**The real finding is one level down.** Healthy channels should not be producing
99.5th-percentile z-scores of 8 sigma. That they do means the underlying
statistic is wrong for this data:

> z-scores assume roughly Gaussian behaviour. Real server telemetry is spiky,
> bursty and often near-constant with occasional jumps. Mean and standard
> deviation are both badly non-robust to exactly that shape, so a handful of
> normal spikes inflate sigma and distort every subsequent score.

Tuning thresholds on top of a fragile statistic cannot fix a fragile statistic.
The honest successor is to replace it: **median and MAD (median absolute
deviation)** instead of mean and sigma, which are robust to precisely this kind
of contamination. That is now the top roadmap item, and it is a different and
better bet than anything tried so far.

What was kept: the engine gained `zThresholdPerMetric`, which works exactly as
specified and lets an operator who *knows* a channel is bursty raise its bar by
hand. What was rejected is deriving those numbers automatically by this method.
The learner and the `faultline_learned` detector remain in the benchmark package
so these numbers stay reproducible — the benchmark is a research log, and a
negative result nobody can re-run is not evidence.

## What would actually move the number

In rough order of expected value, with tried-and-rejected items struck:

1. ~~Change-point detection~~ — tried, measured, made things worse.
2. ~~Per-channel learned thresholds~~ — tried, better on average, catastrophic
   on one machine in four. Rejected, and it exposed the item below.
3. **Robust statistics: median/MAD instead of mean/sigma.** The diagnosis above
   says the base statistic, not the threshold, is what breaks on real telemetry.
   Now the highest-value untried change.
4. **Seasonality awareness.** Daily and weekly cycles are currently
   indistinguishable from drift.
5. **Correlation structure.** Convergence currently means "≥ N signals
   qualified". Weighting by whether those channels are *historically* correlated
   would separate genuine cascades from unrelated coincident movement.

Items 3–5 are not implemented. They are the honest roadmap, and the backtest
harness exists to tell whether any of them help — as it already did for items 1
and 2, by rejecting both.

That is the point of this document. Every idea gets measured against real
labelled data before it ships. Two of the first three ideas lost, and saying so
is more useful than a roadmap of untested optimism.

**A note on reading aggregate metrics.** Item 2 improved aggregate F1 by 21% and
cut false alerts by two thirds, and was still the wrong thing to ship, because
one machine in four went blind. When a monitoring system fails, it fails on
*your* system, not on the average system — so per-subject worst case matters
more than the mean. Every result in this document is therefore reported per
machine as well as aggregated.
