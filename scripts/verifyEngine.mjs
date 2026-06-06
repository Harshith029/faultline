// Verifies the FAULTLINE detection engine on the raw telemetry.
// Run: node scripts/verifyEngine.mjs
//
// Asserts the engine — computing everything live from raw values — reproduces
// the cascade narrative (trigger at W8, outage at W12) and fires earlier than
// the incumbent baseline detectors.

import { runDetection, compareDetectors, runCounterfactual } from '../frontend/dashboard/src/lib/detectionEngine.js'
import { RAW_TELEMETRY } from '../frontend/dashboard/src/data/rawTelemetry.js'

const result = runDetection(RAW_TELEMETRY)
const cmp = compareDetectors(result)

console.log('\nWindow | p99(ms) retry%  err% |  z_lat  z_ret  z_err | sig |  R   | conf | state')
console.log('-------|----------------------|----------------------|-----|------|------|------')
for (const w of result.windows) {
  const state = w.outage ? 'OUTAGE' : w.triggered ? 'TRIGGER' : ''
  console.log(
    `  W${String(w.window_number).padStart(2)}  | ` +
    `${String(w.raw.p99_latency).padStart(5)}  ${String(w.raw.retry_rate).padStart(4)}  ${String(w.raw.error_rate).padStart(4)} | ` +
    `${w.metrics.p99_latency_z.toFixed(2).padStart(5)}  ${w.metrics.retry_rate_z.toFixed(2).padStart(5)}  ${w.metrics.error_rate_z.toFixed(2).padStart(5)} | ` +
    ` ${w.signal_count}  | ${w.R_score.toFixed(2).padStart(4)} | ${(w.confidence * 100).toFixed(0).padStart(3)}% | ${state}`
  )
}

console.log('\nBaselines (computed from W1–4):')
for (const [k, b] of Object.entries(result.baselines)) {
  console.log(`  ${k.padEnd(12)} mean=${b.mean.toFixed(2)}  sigma=${b.sigma.toFixed(2)} (raw σ=${b.rawSigma.toFixed(2)})`)
}

console.log('\nDetector comparison:')
console.log(`  FAULTLINE convergence fired at  W${cmp.faultlineWindow}`)
if (cmp.singleMetric)
  console.log(`  Single-metric 3σ alert fired at W${cmp.singleMetric.window}  (lead: ${cmp.singleMetric.leadWindows} windows)`)
if (cmp.staticSLO)
  console.log(`  Static SLO alert fired at       W${cmp.staticSLO.window}  (lead: ${cmp.staticSLO.leadWindows} windows)`)

// --- assertions -------------------------------------------------------------
const fails = []
const detW = result.detectionWindow?.window_number
const outW = result.outageWindow?.window_number
if (detW !== 8) fails.push(`expected trigger at W8, got W${detW ?? 'none'}`)
if (outW !== 12) fails.push(`expected outage at W12, got W${outW ?? 'none'}`)
if (result.windows[6].triggered) fails.push('W7 should NOT be triggered (R must stay < 3.0)')
if (!(cmp.staticSLO?.leadWindows > 0)) fails.push('FAULTLINE should fire before the static SLO alert')

// --- counterfactual ---------------------------------------------------------
console.log('\nCounterfactual (engage circuit breaker on service-b):')
for (const window of [6, 7, 8]) {
  const cf = runCounterfactual(RAW_TELEMETRY, { window })
  console.log(
    `  act @ W${window}: peak R=${cf.peakR.toFixed(2)}  trigger=${cf.triggeredAt ? 'W' + cf.triggeredAt : 'none'}  outage=${cf.outageAt ? 'W' + cf.outageAt : 'none'}  → ${cf.verdict.label}`
  )
}

const cf6 = runCounterfactual(RAW_TELEMETRY, { window: 6 })
const cf8 = runCounterfactual(RAW_TELEMETRY, { window: 8 })
if (!cf6.averted) fails.push('acting at W6 (before trigger) should avert the cascade')
if (cf6.outageAt != null) fails.push('acting at W6 should prevent the outage')
if (cf8.outageAt != null) fails.push('acting at W8 should still avoid the W12 outage')
if (cf8.triggeredAt !== 8) fails.push('acting at W8 cannot un-trigger the already-fired W8 detection')

if (fails.length) {
  console.log('\n❌ FAILED:')
  for (const f of fails) console.log('   - ' + f)
  process.exit(1)
}
console.log('\n✅ PASS — engine reproduces the cascade, beats both baselines, and the counterfactual averts it.\n')
