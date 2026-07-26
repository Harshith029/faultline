import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RollingDetector } from '../src/detector.js'
import { createSyntheticSource } from '../src/sources/synthetic.js'
import { detectorParams, loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

const params = (overrides = {}) =>
  detectorParams(loadConfig({ env: {}, overrides: { detector: { baselineWindows: 8, minSustain: 2, historyWindows: 60, ...overrides } } }))

test('reports warming_up until enough windows exist', () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })
  for (let i = 0; i < 9; i++) {
    const [result] = detector.ingest([{ service: 'api', p99_latency: 100, retry_rate: 0.5, error_rate: 0.2 }])
    assert.equal(result.status, 'warming_up')
    assert.equal(result.windowsRequired, 10)
  }
  const [ready] = detector.ingest([{ service: 'api', p99_latency: 100, retry_rate: 0.5, error_rate: 0.2 }])
  assert.equal(ready.status, 'evaluated')
})

test('a steady service never triggers', async () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })
  const source = createSyntheticSource({ seed: 21 }, { logger: silentLogger })
  let triggeredAny = false
  for (let i = 0; i < 40; i++) {
    const results = detector.ingest(await source.collect())
    triggeredAny ||= results.some((r) => r.status === 'evaluated' && r.evaluation.triggered)
  }
  assert.equal(triggeredAny, false, 'nominal telemetry must not produce a detection')
})

test('an injected cascade is detected on the affected service only', async () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })
  const source = createSyntheticSource(
    { seed: 7, incident: { service: 'checkout-api', startAfterWindows: 12 } },
    { logger: silentLogger }
  )

  let firstTriggerTick = null
  let triggerEvaluation = null
  const otherServicesTriggered = new Set()

  for (let tick = 0; tick < 40; tick++) {
    const results = detector.ingest(await source.collect())
    for (const result of results) {
      if (result.status !== 'evaluated' || !result.evaluation.triggered) continue
      if (result.service === 'checkout-api') {
        if (firstTriggerTick === null) {
          firstTriggerTick = tick
          triggerEvaluation = result.evaluation
        }
      } else {
        otherServicesTriggered.add(result.service)
      }
    }
  }

  assert.notEqual(firstTriggerTick, null, 'the injected cascade should have been detected')
  assert.ok(firstTriggerTick > 12, 'detection must not precede the injected fault')
  assert.ok(firstTriggerTick < 30, `detection was too slow (tick ${firstTriggerTick})`)
  assert.equal(otherServicesTriggered.size, 0, 'unaffected services must stay clean')
  assert.ok(triggerEvaluation.R_score >= 3.0)
  assert.ok(triggerEvaluation.qualified_signals.length >= 1)
})

test('detection is driven by converging signals, not one metric', async () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })
  const source = createSyntheticSource(
    { seed: 7, incident: { service: 'checkout-api', startAfterWindows: 12 } },
    { logger: silentLogger }
  )
  let peakSignals = 0
  for (let tick = 0; tick < 34; tick++) {
    const results = detector.ingest(await source.collect())
    const checkout = results.find((r) => r.service === 'checkout-api')
    if (checkout?.status === 'evaluated') peakSignals = Math.max(peakSignals, checkout.evaluation.signal_count)
  }
  assert.ok(peakSignals >= 2, `expected multi-signal convergence, peaked at ${peakSignals}`)
})

test('missing or non-numeric metrics are coerced rather than crashing', () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })
  for (let i = 0; i < 10; i++) {
    detector.ingest([{ service: 'api', p99_latency: 'not-a-number', error_rate: null }])
  }
  const [result] = detector.ingest([{ service: 'api' }])
  assert.equal(result.status, 'evaluated')
  assert.equal(result.evaluation.triggered, false)
})

test('samples without a service are ignored', () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })
  const results = detector.ingest([{ p99_latency: 100 }, null, undefined])
  assert.equal(results.length, 0)
})

test('the buffer never exceeds the configured history', async () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 15, logger: silentLogger })
  const source = createSyntheticSource({ seed: 2 }, { logger: silentLogger })
  for (let i = 0; i < 40; i++) detector.ingest(await source.collect())
  assert.equal(detector.buffer.size('checkout-api'), 15)
  assert.equal(detector.windowsFor('checkout-api').length, 15)
})
