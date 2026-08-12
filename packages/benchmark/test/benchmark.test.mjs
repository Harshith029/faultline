import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateScenario, scenarioNames, SCENARIOS } from '../src/scenarios.js'
import {
  faultlineDetector,
  faultlineRollingDetector,
  faultlineFixedBaselineDetector,
  singleMetricDetector,
  staticSloDetector,
  BENCH_PARAMS,
  STRICT_PARAMS,
  DETECTORS,
} from '../src/detectors.js'
import { evaluate, leadTimeComparison } from '../src/evaluate.js'

test('every scenario generates a well-formed series', () => {
  for (const name of scenarioNames()) {
    const scenario = generateScenario(name, 1)
    assert.equal(scenario.windows.length, 60)
    for (const w of scenario.windows) {
      assert.ok(Number.isFinite(w.p99_latency) && w.p99_latency >= 0)
      assert.ok(Number.isFinite(w.retry_rate) && w.retry_rate >= 0)
      assert.ok(Number.isFinite(w.error_rate) && w.error_rate >= 0)
    }
    assert.ok(['fire', 'quiet'].includes(scenario.expect))
  }
})

test('scenario generation is deterministic per seed', () => {
  const a = generateScenario('classic-cascade', 99)
  const b = generateScenario('classic-cascade', 99)
  assert.deepEqual(a.windows, b.windows)
  const c = generateScenario('classic-cascade', 100)
  assert.notDeepEqual(a.windows, c.windows)
})

test('unknown scenarios fail loudly', () => {
  assert.throws(() => generateScenario('does-not-exist', 1), /Unknown scenario/)
})

test('every labeled cascade is detected', () => {
  for (const spec of SCENARIOS.filter((s) => s.expect === 'fire')) {
    const scenario = generateScenario(spec.name, 1234)
    const result = faultlineDetector(scenario.windows)
    assert.notEqual(result.firedAt, null, `${spec.name} should be detected`)
    assert.ok(result.firedAt >= spec.onset, `${spec.name} fired before its onset`)
  }
})

test('a healthy noisy service never triggers', () => {
  for (let seed = 0; seed < 15; seed++) {
    const scenario = generateScenario('noisy-baseline', 500 + seed)
    assert.equal(faultlineDetector(scenario.windows).firedAt, null)
  }
})

test('seasonal load never triggers the fixed-baseline reference detector', () => {
  for (let seed = 0; seed < 15; seed++) {
    const scenario = generateScenario('seasonal-traffic', 700 + seed)
    assert.equal(faultlineFixedBaselineDetector(scenario.windows).firedAt, null)
  }
})

test('seasonal load is mostly, but not entirely, quiet under the deployed rolling detector', () => {
  // An honest regression barrier for real behaviour rather than an aspiration.
  //
  // The rolling baseline ages, so a slow seasonal climb can eventually sit far
  // enough above a baseline built from the trough to qualify. The fixed-baseline
  // reference never sees this because its baseline is pinned to the first
  // windows of the series forever. This is the deployed detector's actual
  // weakness on seasonality and the benchmark should show it, not hide it.
  let fired = 0
  for (let seed = 0; seed < 15; seed++) {
    const scenario = generateScenario('seasonal-traffic', 700 + seed)
    if (faultlineRollingDetector(scenario.windows).firedAt !== null) fired += 1
  }

  assert.ok(fired <= 2, `seasonal false-positive rate regressed: ${fired}/15 seeds fired`)
})

test('a lone sustained signal does not page, because convergence is required', () => {
  let fired = 0
  for (let seed = 0; seed < 20; seed++) {
    if (faultlineDetector(generateScenario('isolated-sustained-metric', 1000 + seed * 7).windows).firedAt) {
      fired += 1
    }
  }
  assert.ok(fired <= 4, `a single signal should rarely trigger, fired ${fired}/20`)
})

test('the strict profile suppresses a two-window blip', () => {
  let strictFired = 0
  for (let seed = 0; seed < 20; seed++) {
    const windows = generateScenario('transient-multi-spike', 1000 + seed * 7).windows
    if (faultlineDetector(windows, STRICT_PARAMS).firedAt) strictFired += 1
  }
  assert.equal(strictFired, 0, 'minSustain=3 should reject a two-window spike')
})

test('the single-metric baseline is measurably noisier than FAULTLINE', () => {
  let ourFP = 0
  let theirFP = 0
  for (const spec of SCENARIOS.filter((s) => s.expect === 'quiet')) {
    for (let seed = 0; seed < 10; seed++) {
      const windows = generateScenario(spec.name, 1000 + seed * 7).windows
      if (faultlineDetector(windows).firedAt) ourFP += 1
      if (singleMetricDetector(windows).firedAt) theirFP += 1
    }
  }
  assert.ok(ourFP < theirFP, `expected fewer false positives (${ourFP}) than single-metric (${theirFP})`)
})

test('the static SLO baseline is slow on error-led cascades', () => {
  const windows = generateScenario('error-led-cascade', 1234).windows
  const ours = faultlineDetector(windows).firedAt
  const slo = staticSloDetector(windows).firedAt
  assert.notEqual(ours, null)
  if (slo !== null) assert.ok(slo >= ours, 'FAULTLINE should not be slower than a static SLO here')
})

test('evaluate returns coherent aggregate metrics', () => {
  const result = evaluate({ seeds: 5 })
  const faultline = result.summary.find((s) => s.key === 'faultline')
  assert.equal(faultline.recall, 1, 'every labeled cascade should be caught')
  assert.ok(faultline.precision > 0.5)
  assert.equal(faultline.tp + faultline.fn, 5 * SCENARIOS.filter((s) => s.expect === 'fire').length)
  assert.equal(faultline.fp + faultline.tn, 5 * SCENARIOS.filter((s) => s.expect === 'quiet').length)
})

test('the strict profile trades detection delay for precision', () => {
  const result = evaluate({ seeds: 10 })
  const base = result.summary.find((s) => s.key === 'faultline')
  const strict = result.summary.find((s) => s.key === 'faultline_strict')
  assert.ok(strict.precision > base.precision, 'strict should be more precise')
  assert.ok(strict.medianDetectionDelay >= base.medianDetectionDelay, 'strict should not be faster')
})

test('lead time is only counted where both detectors fired', () => {
  const leads = leadTimeComparison({ seeds: 5 })
  assert.ok(leads.length > 0)
  for (const lead of leads) {
    // A baseline that never fires contributes no comparable samples, which is
    // the point: it must not be able to look fast by staying silent.
    assert.ok(lead.wonOrTied <= lead.samples)
    if (lead.samples === 0) assert.equal(lead.medianLeadWindows, null)
    else assert.equal(typeof lead.medianLeadWindows, 'number')
  }
  const sustained = leads.find((l) => l.key === 'sustained_3sigma')
  assert.ok(sustained.samples > 0, 'a detector that fires reliably should be comparable')
})

test('benchmark params keep sigma floors below the generated noise', () => {
  assert.ok(BENCH_PARAMS.sigmaFloorRatio < 0.1)
  assert.equal(BENCH_PARAMS.minSignals, 2)
})

test('the default benchmark detector is the agent\'s rolling detector, not the fixed-baseline one', () => {
  // FL-08: the headline benchmark must gate the code that actually ships.
  assert.equal(faultlineDetector, faultlineRollingDetector)

  const deployed = DETECTORS.find((d) => d.key === 'faultline')
  assert.equal(deployed.deployed, true)
  assert.match(deployed.label, /rolling/)

  const reference = DETECTORS.find((d) => d.key === 'faultline_fixed_baseline')
  assert.equal(reference.reference, true)
  assert.match(reference.label, /reference/)
})

test('the rolling detector cannot see the future: it fires no earlier than its warm-up', () => {
  const scenario = generateScenario('two-signal-cascade', 4242)
  const { firedAt } = faultlineRollingDetector(scenario.windows)

  assert.ok(firedAt !== null, 'a labelled cascade must still be detected')
  // It needs baselineWindows + minSustain samples buffered before it can score.
  assert.ok(
    firedAt >= BENCH_PARAMS.baselineWindows + BENCH_PARAMS.minSustain,
    `fired at ${firedAt}, before enough windows existed to compute a baseline`
  )
})

test('rolling and fixed-baseline detectors give measurably different verdicts', () => {
  // If these ever agreed everywhere, one of them would be redundant — and the
  // original bug was assuming they agreed.
  let differences = 0
  for (let seed = 0; seed < 15; seed++) {
    const scenario = generateScenario('deploy-step-change', 900 + seed)
    const rolling = faultlineRollingDetector(scenario.windows).firedAt
    const fixed = faultlineFixedBaselineDetector(scenario.windows).firedAt
    if (rolling !== fixed) differences += 1
  }

  assert.ok(differences > 0, 'the two detectors produced identical results; the benchmark is not measuring the agent')
})
