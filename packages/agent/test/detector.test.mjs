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

test('a sample with non-numeric or null metrics is rejected, not coerced to zero', () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })

  const [result] = detector.ingest([
    { service: 'api', p99_latency: 'not-a-number', retry_rate: 1, error_rate: null },
  ])

  assert.equal(result.status, 'incomplete_sample')
  assert.deepEqual(result.missing, ['p99_latency', 'error_rate'])
  assert.equal(detector.buffer.size('api'), 0, 'nothing may enter the rolling buffer')
})

test('an entirely empty sample is rejected rather than buffered as zeros', () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })

  const [result] = detector.ingest([{ service: 'api' }])

  assert.equal(result.status, 'incomplete_sample')
  assert.deepEqual(result.missing, ['p99_latency', 'retry_rate', 'error_rate'])
  assert.equal(detector.incompleteSamples, 1)
})

test('dropping a metric mid-incident cannot silence it by zero-filling', () => {
  // The failure this guards: an exporter stops exposing retry_rate and
  // error_rate. Under the old coercion those became 0, the convergence
  // requirement was never met, and a live incident went quiet.
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })

  for (let i = 0; i < 12; i++) {
    detector.ingest([{ service: 'api', p99_latency: 100, retry_rate: 1, error_rate: 0.5 }])
  }
  // Incident begins across all three signals.
  for (let i = 0; i < 4; i++) {
    detector.ingest([{ service: 'api', p99_latency: 400, retry_rate: 9, error_rate: 6 }])
  }

  // Now the exporter loses two of the three series.
  const [result] = detector.ingest([{ service: 'api', p99_latency: 400 }])

  assert.equal(result.status, 'incomplete_sample')
  assert.deepEqual(result.missing, ['retry_rate', 'error_rate'])

  // The last complete evaluation is preserved; the gap did not overwrite it
  // with a healthier-looking window.
  const windows = detector.windowsFor('api')
  assert.equal(windows.length, 16, 'the incomplete sample must not extend the series')
  assert.equal(windows.at(-1).raw.error_rate, 6)
})

test('freshness reports how long ago each service last produced a complete sample', () => {
  const detector = new RollingDetector({ params: params(), historyWindows: 60, logger: silentLogger })
  const t0 = Date.UTC(2024, 0, 1)

  detector.ingest([{ service: 'api', p99_latency: 100, retry_rate: 1, error_rate: 0.5 }], { nowMs: t0 })

  const [fresh] = detector.freshness(t0 + 90_000)
  assert.equal(fresh.service, 'api')
  assert.equal(fresh.staleSeconds, 90)
})

test('the agent detects on a custom metric set end to end', () => {
  const custom = detectorParams(
    loadConfig({
      env: {},
      overrides: {
        detector: {
          metrics: ['queue_depth', 'consumer_lag'],
          minSignals: 2,
          baselineWindows: 8,
          minSustain: 2,
          historyWindows: 60,
        },
      },
    })
  )
  const detector = new RollingDetector({ params: custom, historyWindows: 60, logger: silentLogger })

  let fired = null
  for (let i = 1; i <= 24; i++) {
    const escalating = i >= 12 ? (i - 11) * 4 : 0
    const [result] = detector.ingest([
      {
        service: 'ingest-worker',
        queue_depth: 100 + (i % 3) + escalating * 6,
        consumer_lag: 20 + (i % 2) + escalating * 3,
      },
    ])
    if (result.status === 'evaluated' && result.evaluation.triggered && fired === null) fired = i
  }

  assert.notEqual(fired, null, 'a queue/lag cascade should be detected')
  assert.ok(fired > 12, 'detection must not precede the fault')
  const windows = detector.windowsFor('ingest-worker')
  assert.ok('queue_depth_z' in windows.at(-1).metrics)
  assert.ok(!('p99_latency_z' in windows.at(-1).metrics))
})

test('config rejects minSignals larger than the metric set', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { detector: { metrics: ['only_one'], minSignals: 2 } } }),
    /cannot exceed the number of metrics/
  )
})

test('config rejects an empty or duplicated metric list', () => {
  assert.throws(() => loadConfig({ env: {}, overrides: { detector: { metrics: [] } } }), /non-empty array/)
  assert.throws(
    () => loadConfig({ env: {}, overrides: { detector: { metrics: ['a', 'a'] } } }),
    /must not contain duplicates/
  )
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
