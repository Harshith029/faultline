import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PARAMS,
  computeBaseline,
  zScore,
  riskScore,
  confidenceFromRisk,
  runDetection,
  runBaselineDetectors,
  compareDetectors,
  applyMitigation,
  runCounterfactual,
  MITIGATIONS,
} from '../src/lib/detectionEngine.js'
import { RAW_TELEMETRY } from '../src/data/rawTelemetry.js'

test('computeBaseline derives mean and sigma from the baseline window', () => {
  const b = computeBaseline([10, 12, 8, 10, 100, 200], { ...DEFAULT_PARAMS, baselineWindows: 4 })
  assert.equal(b.mean, 10)
  assert.ok(Math.abs(b.rawSigma - Math.sqrt(2)) < 1e-9)
})

test('computeBaseline floors sigma at sigmaFloorRatio of the mean', () => {
  const b = computeBaseline([100, 100, 100, 100], DEFAULT_PARAMS)
  assert.equal(b.rawSigma, 0)
  assert.equal(b.sigma, 100 * DEFAULT_PARAMS.sigmaFloorRatio)
})

test('computeBaseline never returns zero sigma', () => {
  const b = computeBaseline([0, 0, 0, 0], DEFAULT_PARAMS)
  assert.ok(b.sigma > 0)
})

test('zScore is the standard score', () => {
  assert.equal(zScore(120, { mean: 100, sigma: 10 }), 2)
  assert.equal(zScore(80, { mean: 100, sigma: 10 }), -2)
})

test('riskScore is zero with no qualified signals', () => {
  assert.equal(riskScore([], DEFAULT_PARAMS), 0)
})

test('riskScore follows mean_z * ln(1 + n) * W', () => {
  const expected = 3 * Math.log(3) * DEFAULT_PARAMS.criticalityWeight
  assert.ok(Math.abs(riskScore([2, 4], DEFAULT_PARAMS) - expected) < 1e-9)
})

test('confidenceFromRisk is bounded and monotone', () => {
  assert.equal(confidenceFromRisk(0), 0)
  assert.equal(confidenceFromRisk(-1), 0)
  assert.ok(confidenceFromRisk(3) > confidenceFromRisk(1))
  assert.ok(confidenceFromRisk(1000) <= 0.99)
})

test('a single-window spike never qualifies', () => {
  const raw = RAW_TELEMETRY.slice(0, 8).map((w) => ({ ...w }))
  raw[4] = { ...raw[4], p99_latency: 100, retry_rate: 0.5, error_rate: 0.4 }
  raw[5] = { ...raw[5], p99_latency: 400, retry_rate: 0.5, error_rate: 0.4 }
  raw[6] = { ...raw[6], p99_latency: 100, retry_rate: 0.5, error_rate: 0.4 }
  raw[7] = { ...raw[7], p99_latency: 100, retry_rate: 0.5, error_rate: 0.4 }
  const { windows } = runDetection(raw)
  assert.equal(windows[5].signal_count, 0)
  assert.equal(windows[5].R_score, 0)
})

test('runDetection reproduces the reference cascade', () => {
  const result = runDetection(RAW_TELEMETRY)
  assert.equal(result.windows.length, 12)
  assert.equal(result.detectionWindow.window_number, 8)
  assert.equal(result.outageWindow.window_number, 12)
  assert.equal(result.windows[6].triggered, false)
  assert.equal(result.windows[7].signal_count, 2)
  assert.equal(result.windows[7].R_score, 3.96)
  assert.equal(result.windows[8].signal_count, 3)
  assert.equal(result.windows[11].outage, true)
})

test('runDetection respects a custom trigger threshold', () => {
  const result = runDetection(RAW_TELEMETRY, { ...DEFAULT_PARAMS, triggerThreshold: 100 })
  assert.equal(result.detectionWindow, null)
})

test('baseline detectors fire where expected on the reference data', () => {
  const detection = runDetection(RAW_TELEMETRY)
  const baselines = runBaselineDetectors(detection)
  assert.equal(baselines.staticSLO.window, 11)
  assert.equal(baselines.singleMetric.window, 8)
})

test('compareDetectors reports lead time in windows', () => {
  const cmp = compareDetectors(runDetection(RAW_TELEMETRY))
  assert.equal(cmp.faultlineWindow, 8)
  assert.equal(cmp.staticSLO.leadWindows, 3)
  assert.equal(cmp.singleMetric.leadWindows, 0)
})

test('applyMitigation leaves windows before the intervention untouched', () => {
  const mitigated = applyMitigation(RAW_TELEMETRY, { window: 6 })
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(mitigated[i], RAW_TELEMETRY[i])
  }
})

test('applyMitigation decays excess toward baseline without undershooting', () => {
  const mitigated = applyMitigation(RAW_TELEMETRY, { window: 6 })
  const baselineMean = computeBaseline(RAW_TELEMETRY.map((w) => w.p99_latency), DEFAULT_PARAMS).mean
  for (let i = 6; i < mitigated.length; i++) {
    assert.ok(mitigated[i].p99_latency <= mitigated[i - 1].p99_latency + 1e-9)
    assert.ok(mitigated[i].p99_latency >= baselineMean - 1e-9)
  }
})

test('every mitigation profile is well-formed', () => {
  for (const m of Object.values(MITIGATIONS)) {
    assert.ok(m.label.length > 0)
    for (const d of Object.values(m.decay)) {
      assert.ok(d > 0 && d < 1)
    }
  }
})

test('acting before the trigger averts the cascade', () => {
  for (const window of [6, 7]) {
    const cf = runCounterfactual(RAW_TELEMETRY, { window })
    assert.equal(cf.verdict.status, 'averted')
    assert.equal(cf.triggeredAt, null)
    assert.equal(cf.outageAt, null)
  }
})

test('acting at the trigger window mitigates but cannot untrigger', () => {
  const cf = runCounterfactual(RAW_TELEMETRY, { window: 8 })
  assert.equal(cf.verdict.status, 'mitigated')
  assert.equal(cf.triggeredAt, 8)
  assert.equal(cf.outageAt, null)
  assert.ok(cf.peakR < 12.06)
})

test('counterfactual reports the unmitigated reference points', () => {
  const cf = runCounterfactual(RAW_TELEMETRY, { window: 6 })
  assert.equal(cf.baselineTriggeredAt, 8)
  assert.equal(cf.baselineOutageAt, 12)
})
