import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileServiceRules, matchRule, createParamsResolver } from '../src/serviceConfig.js'
import { loadConfig, detectorParams } from '../src/config.js'
import { RollingDetector } from '../src/detector.js'
import { silentLogger } from '../src/logger.js'

const base = { triggerThreshold: 3, criticalityWeight: 1, minSustain: 2, baselineWindows: 8, minSignals: 2 }

test('an exact match beats a wildcard regardless of declaration order', () => {
  const rules = compileServiceRules([
    { match: '*', triggerThreshold: 9 },
    { match: 'checkout-api', triggerThreshold: 2 },
  ])
  assert.equal(matchRule('checkout-api', rules).overrides.triggerThreshold, 2)
  assert.equal(matchRule('anything-else', rules).overrides.triggerThreshold, 9)
})

test('among wildcards the first declared rule wins', () => {
  const rules = compileServiceRules([
    { match: 'batch-*', triggerThreshold: 5 },
    { match: '*', triggerThreshold: 9 },
  ])
  assert.equal(matchRule('batch-nightly', rules).overrides.triggerThreshold, 5)
  assert.equal(matchRule('web-1', rules).overrides.triggerThreshold, 9)
})

test('wildcards only match where they are placed', () => {
  const rules = compileServiceRules([{ match: 'api-*-eu' }])
  assert.ok(matchRule('api-checkout-eu', rules))
  assert.equal(matchRule('api-checkout-us', rules), null)
  assert.equal(matchRule('xapi-checkout-eu', rules), null)
})

test('special characters in a service name are matched literally', () => {
  const rules = compileServiceRules([{ match: 'svc.a+b', triggerThreshold: 4 }])
  assert.ok(matchRule('svc.a+b', rules))
  assert.equal(matchRule('svcXaXb', rules), null)
})

test('unmatched services fall through to the global params object', () => {
  const resolve = createParamsResolver(base, compileServiceRules([{ match: 'other' }]))
  const resolved = resolve('checkout-api')
  assert.equal(resolved.params, base, 'should reuse the base object, not a copy')
  assert.equal(resolved.profile, null)
})

test('a matched service merges overrides over the base', () => {
  const resolve = createParamsResolver(
    base,
    compileServiceRules([{ match: 'checkout-api', name: 'tier-1', triggerThreshold: 2, criticalityWeight: 3 }])
  )
  const { params, profile } = resolve('checkout-api')
  assert.equal(profile, 'tier-1')
  assert.equal(params.triggerThreshold, 2)
  assert.equal(params.criticalityWeight, 3)
  assert.equal(params.minSustain, base.minSustain, 'unspecified keys still fall through')
  assert.equal(base.triggerThreshold, 3, 'the base object must not be mutated')
})

test('resolution is cached per service', () => {
  const resolve = createParamsResolver(base, compileServiceRules([{ match: 'a', triggerThreshold: 1 }]))
  assert.equal(resolve('a'), resolve('a'))
})

test('criticalityWeight raises risk for a critical service on identical telemetry', () => {
  const config = loadConfig({
    env: {},
    overrides: {
      detector: { baselineWindows: 6, minSustain: 2, historyWindows: 40 },
      services: [{ match: 'tier1-*', name: 'tier-1', criticalityWeight: 3 }],
    },
  })
  const detector = new RollingDetector({
    params: detectorParams(config),
    resolveParams: (s) =>
      createParamsResolver(detectorParams(config), compileServiceRules(config.services))(s),
    historyWindows: 40,
    logger: silentLogger,
  })

  let normal = null
  let critical = null
  for (let i = 1; i <= 12; i++) {
    const escalating = i >= 7 ? (i - 6) * 2 : 0
    const sample = (service) => ({
      service,
      p99_latency: 100 + (i % 2) * 3 + escalating * 12,
      retry_rate: 0.5 + (i % 2) * 0.03 + escalating * 0.12,
      error_rate: 0.2 + (i % 2) * 0.02 + escalating * 0.05,
    })
    const results = detector.ingest([sample('normal-api'), sample('tier1-api')])
    for (const r of results) {
      if (r.status !== 'evaluated') continue
      if (r.service === 'normal-api') normal = r
      else critical = r
    }
  }

  assert.equal(critical.profile, 'tier-1')
  assert.equal(normal.profile, null)
  assert.ok(
    critical.evaluation.R_score > normal.evaluation.R_score,
    `critical service should score higher: ${critical.evaluation.R_score} vs ${normal.evaluation.R_score}`
  )
})

test('a per-service metric set is honoured independently', () => {
  const config = loadConfig({
    env: {},
    overrides: {
      detector: { baselineWindows: 6, minSustain: 2, historyWindows: 40 },
      services: [{ match: 'queue-worker', name: 'queues', metrics: ['queue_depth', 'consumer_lag'] }],
    },
  })
  const resolve = createParamsResolver(detectorParams(config), compileServiceRules(config.services))
  const detector = new RollingDetector({
    params: detectorParams(config),
    resolveParams: resolve,
    historyWindows: 40,
    logger: silentLogger,
  })

  for (let i = 1; i <= 12; i++) {
    const escalating = i >= 7 ? (i - 6) * 3 : 0
    detector.ingest([
      { service: 'queue-worker', queue_depth: 100 + (i % 2) + escalating * 8, consumer_lag: 20 + escalating * 4 },
      { service: 'web', p99_latency: 100 + (i % 2), retry_rate: 0.5, error_rate: 0.2 },
    ])
  }

  const queueWindows = detector.windowsFor('queue-worker')
  assert.ok('queue_depth_z' in queueWindows.at(-1).metrics)
  assert.ok(!('p99_latency_z' in queueWindows.at(-1).metrics))

  const webWindows = detector.windowsFor('web')
  assert.ok('p99_latency_z' in webWindows.at(-1).metrics)
  assert.ok(!('queue_depth_z' in webWindows.at(-1).metrics))
})

test('config rejects malformed service rules', () => {
  const bad = (services) => () => loadConfig({ env: {}, overrides: { services } })
  assert.throws(bad([{ triggerThreshold: 2 }]), /requires a non-empty "match"/)
  assert.throws(bad([{ match: 'a' }, { match: 'a' }]), /duplicates match/)
  assert.throws(bad([{ match: 'a', intervalSeconds: 5 }]), /cannot override "intervalSeconds"/)
  assert.throws(bad([{ match: 'a', metrics: [] }]), /must be a non-empty array/)
  assert.throws(bad([{ match: 'a', minSustain: 0 }]), /must be an integer >= 1/)
  assert.throws(bad([{ match: 'a', triggerThreshold: 'high' }]), /must be a finite number/)
  assert.throws(bad('not-an-array'), /services must be an array/)
})

test('config rejects a service whose minSignals exceeds its own metric set', () => {
  assert.throws(
    () =>
      loadConfig({
        env: {},
        overrides: { services: [{ match: 'a', metrics: ['only_one'], minSignals: 2 }] },
      }),
    /exceeds its own metrics count/
  )
})

test('the default config has no service rules and behaves as before', () => {
  const config = loadConfig({ env: {} })
  assert.deepEqual(config.services, [])
  const resolve = createParamsResolver(detectorParams(config), compileServiceRules(config.services))
  assert.equal(resolve('anything').profile, null)
})
