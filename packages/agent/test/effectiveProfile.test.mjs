import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, detectorParams } from '../src/config.js'
import { validateEffectiveProfile, compileServiceRules, createParamsResolver } from '../src/serviceConfig.js'
import { RollingDetector } from '../src/detector.js'
import { silentLogger } from '../src/logger.js'

const load = (overrides) => loadConfig({ env: {}, overrides })

const baseOverrides = (services, detector = {}) => ({
  source: { type: 'synthetic', options: {} },
  detector: { historyWindows: 40, baselineWindows: 10, minSustain: 2, minSignals: 2, ...detector },
  services,
  server: { enabled: false },
})

// --- permanent warm-up ------------------------------------------------------

test('an override that can never accumulate enough windows is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', baselineWindows: 40 }])),
    /would stay in warming_up forever/
  )
})

test('the rejection names the service, the requirement, and the history size', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'batch-*', baselineWindows: 39, minSustain: 3 }])),
    (err) =>
      /services\[0\] \("batch-\*"\)/.test(err.message) &&
      /needs 42 windows/.test(err.message) &&
      /historyWindows is 40/.test(err.message)
  )
})

test('a profile that exactly fills the history window is accepted', () => {
  assert.doesNotThrow(() => load(baseOverrides([{ match: 'checkout-api', baselineWindows: 38, minSustain: 2 }])))
})

test('a valid override still produces a detector that leaves warming_up', () => {
  const config = load(baseOverrides([{ match: 'checkout-api', baselineWindows: 6, minSustain: 2 }]))
  const rules = compileServiceRules(config.services)
  const detector = new RollingDetector({
    params: detectorParams(config),
    resolveParams: createParamsResolver(detectorParams(config), rules),
    historyWindows: config.detector.historyWindows,
    logger: silentLogger,
  })

  let status = 'warming_up'
  for (let i = 0; i < 12; i++) {
    const [result] = detector.ingest([
      { service: 'checkout-api', p99_latency: 100 + i, retry_rate: 1, error_rate: 0.5 },
    ])
    status = result.status
  }

  assert.equal(status, 'evaluated', 'a config that passes validation must actually detect')
})

// --- impossible signal counts -----------------------------------------------

test('requiring more signals than there are metrics is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', minSignals: 4 }])),
    /requires 4 converging signals but only 3 metric\(s\) are configured/
  )
})

test('an override narrowing metrics below the inherited minSignals is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'worker', metrics: ['queue_depth'] }], { minSignals: 2 })),
    /minSignals exceeds its own metrics count \(1\)/
  )
})

test('narrowing metrics and minSignals together is accepted', () => {
  assert.doesNotThrow(() =>
    load(baseOverrides([{ match: 'worker', metrics: ['queue_depth'], minSignals: 1 }]))
  )
})

test('the global default profile is validated too', () => {
  assert.throws(
    () => load(baseOverrides([], { minSignals: 5 })),
    /detector\.minSignals \(5\) cannot exceed the number of metrics \(3\)/
  )
})

test('the default profile is checked for permanent warm-up', () => {
  // The global case was already covered before this change; the gap was that
  // per-service overrides bypassed it entirely.
  assert.throws(
    () => load(baseOverrides([], { baselineWindows: 39, minSustain: 3, historyWindows: 40 })),
    /detector\.historyWindows \(40\) must be >= baselineWindows \+ minSustain \(42\)/
  )
})

// --- invalid numbers --------------------------------------------------------

test('a negative threshold in an override is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', zThreshold: -2 }])),
    /resolves zThreshold to -2; it must be a finite number >= 0/
  )
})

test('a negative criticality weight is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', criticalityWeight: -1 }])),
    /resolves criticalityWeight to -1/
  )
})

test('a negative trigger threshold is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', triggerThreshold: -0.5 }])),
    /resolves triggerThreshold to -0.5/
  )
})

test('a non-integer baselineWindows override is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', baselineWindows: 4.5 }])),
    /baselineWindows must be an integer/
  )
})

test('a single-window baseline is rejected, which the field check alone allows', () => {
  // The per-field rule only requires >= 1. A one-window baseline has no spread
  // to measure, so sigma collapses to the floor and every later window scores
  // against a single sample. Only the effective-profile check catches this.
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', baselineWindows: 1 }])),
    /resolves baselineWindows to 1; it must be an integer >= 2/
  )
})

test('a zero minSustain override is rejected', () => {
  assert.throws(() => load(baseOverrides([{ match: 'checkout-api', minSustain: 0 }])), /minSustain/)
})

// --- structured overrides ---------------------------------------------------

test('a per-metric threshold for a metric the service does not track is rejected', () => {
  assert.throws(
    () =>
      load(
        baseOverrides([
          { match: 'worker', metrics: ['queue_depth', 'lag'], minSignals: 1, zThresholdPerMetric: { p99_latency: 3 } },
        ])
      ),
    /zThresholdPerMetric for "p99_latency", which is not in its metric list/
  )
})

test('a negative per-metric threshold is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', zThresholdPerMetric: { p99_latency: -1 } }])),
    /expected a finite number >= 0/
  )
})

test('a sigma floor for an untracked metric is rejected', () => {
  assert.throws(
    () =>
      load(
        baseOverrides([
          { match: 'worker', metrics: ['queue_depth'], minSignals: 1, sigmaFloorAbs: { error_rate: 1 } },
        ])
      ),
    /sigmaFloorAbs for "error_rate", which is not in its metric list/
  )
})

test('an unknown statistic is rejected', () => {
  assert.throws(
    () => load(baseOverrides([{ match: 'checkout-api', statistic: 'kalman' }])),
    /expected one of mean_sigma, median_mad/
  )
})

test('a valid statistic override is accepted', () => {
  assert.doesNotThrow(() => load(baseOverrides([{ match: 'checkout-api', statistic: 'median_mad' }])))
})

// --- direct unit coverage ---------------------------------------------------

test('validateEffectiveProfile reports every problem at once, not just the first', () => {
  const errors = validateEffectiveProfile(
    {
      metrics: ['a', 'b'],
      baselineWindows: 30,
      minSustain: 2,
      minSignals: 5,
      zThreshold: -1,
      triggerThreshold: 3,
      criticalityWeight: 1,
      sigmaFloorRatio: 0.1,
    },
    { historyWindows: 20, label: 'profile' }
  )

  assert.equal(errors.length, 3)
  assert.ok(errors.some((e) => /zThreshold/.test(e)))
  assert.ok(errors.some((e) => /converging signals/.test(e)))
  assert.ok(errors.some((e) => /warming_up forever/.test(e)))
})

test('an empty metric list is reported without cascading into other errors', () => {
  const errors = validateEffectiveProfile({ metrics: [] }, { historyWindows: 40, label: 'profile' })
  assert.deepEqual(errors, ['profile resolves to an empty metric list'])
})
