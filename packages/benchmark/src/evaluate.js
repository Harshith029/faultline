import { DETECTORS } from './detectors.js'
import { SCENARIOS, generateScenario } from './scenarios.js'

const median = (xs) => {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Runs every detector against every scenario across many seeds and scores the
 * outcome against each scenario's label.
 *
 * A detection only counts as a true positive if it fires at or after the onset
 * window: firing before the fault exists is luck, not detection.
 */
export function evaluate({ seeds = 20, detectors = DETECTORS } = {}) {
  const perDetector = new Map(
    detectors.map((d) => [
      d.key,
      { key: d.key, label: d.label, tp: 0, fp: 0, fn: 0, tn: 0, leadWindows: [], scenarios: [] },
    ])
  )

  for (const spec of SCENARIOS) {
    const results = new Map(detectors.map((d) => [d.key, { fired: 0, delays: [], total: 0 }]))

    for (let s = 0; s < seeds; s++) {
      const scenario = generateScenario(spec.name, 1000 + s * 7)
      for (const detector of detectors) {
        const outcome = detector.run(scenario.windows)
        const bucket = results.get(detector.key)
        bucket.total += 1

        const validFire =
          outcome.firedAt !== null && (scenario.onset === null || outcome.firedAt >= scenario.onset)

        if (validFire) {
          bucket.fired += 1
          if (scenario.onset !== null) bucket.delays.push(outcome.firedAt - scenario.onset)
        }
      }
    }

    for (const detector of detectors) {
      const bucket = results.get(detector.key)
      const agg = perDetector.get(detector.key)
      const missed = bucket.total - bucket.fired

      if (spec.expect === 'fire') {
        agg.tp += bucket.fired
        agg.fn += missed
        agg.leadWindows.push(...bucket.delays)
      } else {
        agg.fp += bucket.fired
        agg.tn += missed
      }

      agg.scenarios.push({
        scenario: spec.name,
        expect: spec.expect,
        firedRuns: bucket.fired,
        totalRuns: bucket.total,
        fireRate: bucket.fired / bucket.total,
        medianDelay: median(bucket.delays),
        correct: spec.expect === 'fire' ? bucket.fired === bucket.total : bucket.fired === 0,
      })
    }
  }

  const summary = [...perDetector.values()].map((agg) => {
    const precision = agg.tp + agg.fp === 0 ? null : agg.tp / (agg.tp + agg.fp)
    const recall = agg.tp + agg.fn === 0 ? null : agg.tp / (agg.tp + agg.fn)
    const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null
    return {
      ...agg,
      precision,
      recall,
      f1,
      medianDetectionDelay: median(agg.leadWindows),
    }
  })

  return { seeds, summary, scenarios: SCENARIOS.map((s) => ({ name: s.name, expect: s.expect, note: s.note })) }
}

/**
 * Lead time of FAULTLINE over each baseline, counted only on runs where both
 * detectors fired, so a detector that simply never fires cannot look fast.
 */
export function leadTimeComparison({ seeds = 20 } = {}) {
  const baselines = DETECTORS.filter((d) => d.key !== 'faultline')
  const faultline = DETECTORS.find((d) => d.key === 'faultline')
  const comparisons = new Map(baselines.map((d) => [d.key, { label: d.label, deltas: [] }]))

  for (const spec of SCENARIOS) {
    if (spec.expect !== 'fire') continue
    for (let s = 0; s < seeds; s++) {
      const scenario = generateScenario(spec.name, 1000 + s * 7)
      const ours = faultline.run(scenario.windows).firedAt
      if (ours === null) continue
      for (const baseline of baselines) {
        const theirs = baseline.run(scenario.windows).firedAt
        if (theirs === null) continue
        comparisons.get(baseline.key).deltas.push(theirs - ours)
      }
    }
  }

  return [...comparisons.entries()].map(([key, value]) => ({
    key,
    label: value.label,
    samples: value.deltas.length,
    medianLeadWindows: median(value.deltas),
    wonOrTied: value.deltas.filter((d) => d >= 0).length,
  }))
}
