import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { createHttpSource, createPrometheusSource } from '../src/sources/index.js'
import { createCloudWatchSource } from '../src/sources/cloudwatch.js'
import { RollingDetector } from '../src/detector.js'
import { silentLogger } from '../src/logger.js'

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    )
  })

const agentWith = async (sourceCollect, overrides = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-nodata-'))
  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'synthetic', options: {} },
      detector: { intervalSeconds: 3600, baselineWindows: 4, minSustain: 2, historyWindows: 20, ...overrides.detector },
      alerting: { notifiers: [] },
      server: { enabled: false },
      storage: { path: join(dir, 'state.json') },
      ...overrides.top,
    },
  })
  const agent = new FaultlineAgent(config, { logger: silentLogger })
  agent.source = { name: 'stub', collect: sourceCollect, state: () => ({}) }
  return agent
}

const goodSample = (over = {}) => ({
  service: 'api',
  p99_latency: 120,
  retry_rate: 1,
  error_rate: 0.4,
  ...over,
})

// --- empty collection -------------------------------------------------------

test('an empty successful collection does not report healthy once the grace period passes', async () => {
  const agent = await agentWith(async () => [], { detector: { noDataGraceSeconds: 60 } })
  await agent.start()

  // Immediately after startup the agent is inside its grace period.
  assert.equal(agent.health().status, 'ok')

  // Past the grace period with nothing ever observed, it must degrade.
  const later = Date.now() + 61_000
  const health = agent.health(later)
  assert.equal(health.status, 'degraded')
  assert.deepEqual(health.reasons, ['no_telemetry_since_start'])

  assert.equal(agent.snapshot().emptyCollections, 1)
  assert.equal(agent.snapshot().services.length, 0)

  await agent.stop()
})

test('empty collections do not reset the collection-error state into looking fine', async () => {
  const agent = await agentWith(async () => [], { detector: { noDataGraceSeconds: 0 } })
  await agent.start()
  await agent.tick()
  await agent.tick()

  const snapshot = agent.snapshot()
  assert.equal(snapshot.consecutiveEmptyCollections, 3)
  // Evaluated at an explicit instant so the assertion does not depend on how
  // many milliseconds the three ticks happened to take.
  assert.equal(agent.health(Date.now() + 1000).status, 'degraded')

  await agent.stop()
})

// --- recovery ---------------------------------------------------------------

test('the agent recovers to healthy once valid telemetry returns', async () => {
  let empty = true
  const agent = await agentWith(async () => (empty ? [] : [goodSample()]), {
    detector: { noDataGraceSeconds: 0 },
  })
  await agent.start()
  assert.equal(agent.health(Date.now() + 1000).status, 'degraded')

  empty = false
  await agent.tick()

  const health = agent.health()
  assert.equal(health.status, 'ok')
  assert.deepEqual(health.reasons, [])
  assert.equal(agent.snapshot().consecutiveEmptyCollections, 0)
  assert.ok(health.lastDataAt !== null)

  await agent.stop()
})

test('health degrades when one previously healthy service becomes stale', async () => {
  const agent = await agentWith(async () => [goodSample(), goodSample({ service: 'worker' })], {
    detector: { noDataGraceSeconds: 60 },
  })
  await agent.start()

  // Keep global telemetry fresh while aging only worker. This models a source
  // that still returns API telemetry after the worker's series disappears.
  const now = Date.now()
  agent.lastDataAtMs = now
  agent.detector.lastCompleteSampleAt.set('api', now)
  agent.detector.lastCompleteSampleAt.set('worker', now - 61_000)

  const health = agent.health(now)
  assert.equal(health.status, 'degraded')
  assert.deepEqual(health.reasons, ['service_telemetry_stale'])
  assert.deepEqual(health.staleServices, ['worker'])

  await agent.stop()
})

test('health uses a sample timestamp, not its receipt time, for freshness', async () => {
  const oldTimestamp = new Date(Date.now() - 61_000).toISOString()
  const agent = await agentWith(async () => [goodSample({ timestamp: oldTimestamp })], {
    detector: { noDataGraceSeconds: 60 },
  })

  await agent.start()

  const health = agent.health()
  assert.equal(health.status, 'degraded')
  assert.deepEqual(health.reasons, ['service_telemetry_stale'])
  assert.deepEqual(health.staleServices, ['api'])

  await agent.stop()
})

test('a no-data gap does not corrupt the baseline when data returns', async () => {
  let mode = 'good'
  const agent = await agentWith(async () => {
    if (mode === 'good') return [goodSample()]
    if (mode === 'gap') return [{ service: 'api', p99_latency: 120 }] // partial
    return [goodSample({ p99_latency: 600, retry_rate: 12, error_rate: 9 })]
  })
  await agent.start()

  for (let i = 0; i < 8; i++) await agent.tick()
  const buffered = agent.detector.buffer.size('api')

  mode = 'gap'
  for (let i = 0; i < 5; i++) await agent.tick()

  assert.equal(
    agent.detector.buffer.size('api'),
    buffered,
    'partial samples must not enter the buffer at all'
  )

  // The baseline is computed from real observations only, so the incident that
  // follows still scores against pre-gap behaviour rather than against zeros.
  const before = agent.detector.detectionFor('api').baselines.p99_latency.mean
  mode = 'incident'
  for (let i = 0; i < 4; i++) await agent.tick()
  const after = agent.detector.detectionFor('api').baselines.p99_latency.mean

  assert.ok(Math.abs(after - before) < 1, `baseline drifted from ${before} to ${after}`)
  assert.ok(agent.detector.detectionFor('api').windows.at(-1).R_score > 0)

  await agent.stop()
})

// --- partial source results -------------------------------------------------

test('a partial HTTP response yields an incomplete sample, not zeros', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // retry_rate and error_rate are absent from the payload.
    res.end(JSON.stringify([{ service: 'api', p99_latency: 300 }]))
  })

  const source = createHttpSource({ url: server.url }, { logger: silentLogger })
  const [sample] = await source.collect()

  assert.equal(sample.p99_latency, 300)
  assert.ok(!('retry_rate' in sample), 'a missing field must stay missing')
  assert.ok(!('error_rate' in sample))

  const agent = await agentWith(async () => [sample])
  await agent.start()
  const [result] = agent.snapshot().services.length
    ? agent.snapshot().services
    : [{ status: 'none' }]
  assert.equal(result.status, 'incomplete_sample')
  assert.deepEqual(result.missingMetrics, ['retry_rate', 'error_rate'])

  await agent.stop()
  server.close()
})

test('an HTTP field that is null or empty string is missing, not zero', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([{ service: 'api', p99_latency: 300, retry_rate: null, error_rate: '' }]))
  })

  const source = createHttpSource({ url: server.url }, { logger: silentLogger })
  const [sample] = await source.collect()

  assert.ok(!('retry_rate' in sample))
  assert.ok(!('error_rate' in sample))

  server.close()
})

test('a Prometheus query returning NaN leaves the metric missing', async () => {
  const server = await listen((req, res) => {
    const query = new URL(req.url, 'http://x').searchParams.get('query')
    // The error_rate query returns NaN, as Prometheus does for empty rate windows.
    const value = query.includes('5..') ? 'NaN' : '42'
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: { service: 'api' }, value: [1700000000, value] }],
        },
      })
    )
  })

  const source = createPrometheusSource({ url: server.url }, { logger: silentLogger })
  const [sample] = await source.collect()

  assert.equal(sample.p99_latency, 42)
  assert.ok(!('error_rate' in sample), 'NaN must not become a metric value')

  const agent = await agentWith(async () => [sample])
  await agent.start()
  const [result] = agent.snapshot().services
  assert.equal(result.status, 'incomplete_sample')
  assert.deepEqual(result.missingMetrics, ['error_rate'])

  await agent.stop()
  server.close()
})

test('a Prometheus service that disappears from one query is reported, not zero-filled', async () => {
  const server = await listen((req, res) => {
    const query = new URL(req.url, 'http://x').searchParams.get('query')
    // "api" is missing entirely from the retry query.
    const result = query.includes('retries')
      ? [{ metric: { service: 'other' }, value: [1700000000, '1'] }]
      : [{ metric: { service: 'api' }, value: [1700000000, '7'] }]
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }))
  })

  const source = createPrometheusSource({ url: server.url }, { logger: silentLogger })
  const samples = await source.collect()
  const api = samples.find((s) => s.service === 'api')

  assert.ok(!('retry_rate' in api))

  server.close()
})

const stubCloudWatch = (metricDataResults) => ({
  cw: { send: async () => ({ MetricDataResults: metricDataResults }) },
  GetMetricDataCommand: class {
    constructor(input) {
      this.input = input
    }
  },
})

test('a CloudWatch period with no datapoint does not become a zero observation', async () => {
  const source = createCloudWatchSource(
    {
      targets: [{ service: 'api', dimensions: { ApiName: 'my-api' } }],
      client: stubCloudWatch([
        { Id: 'm0_0', Values: [250] }, // p99_latency
        { Id: 'm0_1', Values: [] }, // client_error_rate: no datapoint at all
        { Id: 'm0_2', Values: [0.02] }, // error_rate
      ]),
    },
    { logger: silentLogger }
  )

  const [sample] = await source.collect()

  assert.equal(sample.p99_latency, 250)
  assert.ok(!('client_error_rate' in sample), 'an absent datapoint must not become 0')
  assert.equal(sample.error_rate, 2)
})

test('the CloudWatch source no longer labels 4XX errors as a retry rate', async () => {
  const source = createCloudWatchSource(
    {
      targets: [{ service: 'api', dimensions: { ApiName: 'my-api' } }],
      client: stubCloudWatch([
        { Id: 'm0_0', Values: [250] },
        { Id: 'm0_1', Values: [0.05] },
        { Id: 'm0_2', Values: [0.02] },
      ]),
    },
    { logger: silentLogger }
  )

  const [sample] = await source.collect()

  assert.ok(!('retry_rate' in sample))
  assert.equal(sample.client_error_rate, 5)
})

test('a CloudWatch response missing every datapoint produces an incomplete sample', async () => {
  const source = createCloudWatchSource(
    {
      targets: [{ service: 'api', dimensions: { ApiName: 'my-api' } }],
      client: stubCloudWatch([
        { Id: 'm0_0', Values: [] },
        { Id: 'm0_1', Values: [] },
        { Id: 'm0_2', Values: [] },
      ]),
    },
    { logger: silentLogger }
  )

  const [sample] = await source.collect()
  assert.deepEqual(Object.keys(sample).sort(), ['service', 'timestamp'])

  const agent = await agentWith(async () => [sample], {
    detector: { metrics: ['p99_latency', 'client_error_rate', 'error_rate'] },
  })
  await agent.start()

  const [result] = agent.snapshot().services
  assert.equal(result.status, 'incomplete_sample')
  assert.deepEqual(result.missingMetrics, ['p99_latency', 'client_error_rate', 'error_rate'])

  await agent.stop()
})

test('the cloudwatch source refuses to start when it cannot supply the configured metrics', () => {
  assert.throws(
    () =>
      createCloudWatchSource(
        { targets: [{ service: 'api', dimensions: { ApiName: 'a' } }] },
        { logger: silentLogger, config: { detector: { metrics: ['p99_latency', 'retry_rate', 'error_rate'] } } }
      ),
    /cannot supply configured metrics \[retry_rate\]/
  )
})

test('the cloudwatch source starts when the configured metrics match what it emits', () => {
  assert.doesNotThrow(() =>
    createCloudWatchSource(
      { targets: [{ service: 'api', dimensions: { ApiName: 'a' } }] },
      {
        logger: silentLogger,
        config: { detector: { metrics: ['p99_latency', 'client_error_rate', 'error_rate'] } },
      }
    )
  )
})

test('the cloudwatch source validates metrics introduced by service overrides', () => {
  assert.throws(
    () =>
      createCloudWatchSource(
        { targets: [{ service: 'api', dimensions: { ApiName: 'a' } }] },
        {
          logger: silentLogger,
          config: {
            detector: { metrics: ['p99_latency', 'client_error_rate', 'error_rate'] },
            services: [{ match: 'worker', metrics: ['p99_latency', 'retry_rate', 'error_rate'] }],
          },
        }
      ),
    /cannot supply configured metrics \[retry_rate\]/
  )
})

// --- freshness --------------------------------------------------------------

test('per-service freshness distinguishes a stalled service from a healthy one', async () => {
  let include = true
  const agent = await agentWith(async () =>
    include ? [goodSample(), goodSample({ service: 'worker' })] : [goodSample()]
  )
  await agent.start()
  include = false
  await agent.tick()

  const { freshness } = agent.snapshot().dataQuality
  const worker = freshness.find((f) => f.service === 'worker')
  const api = freshness.find((f) => f.service === 'api')

  assert.ok(worker.staleSeconds >= api.staleSeconds)
  assert.ok(worker.lastCompleteSampleAt !== null)

  await agent.stop()
})

test('the snapshot counts incomplete samples separately from collection errors', async () => {
  const agent = await agentWith(async () => [{ service: 'api', p99_latency: 1 }])
  await agent.start()
  await agent.tick()

  const snapshot = agent.snapshot()
  assert.equal(snapshot.collectErrors, 0, 'collection itself succeeded')
  assert.equal(snapshot.dataQuality.incompleteSamples, 2)
  assert.deepEqual(snapshot.dataQuality.lastIncomplete.missing, ['retry_rate', 'error_rate'])

  await agent.stop()
})

// --- freshness across a restart ---------------------------------------------

test('a service restored from disk carries its last-observed time', () => {
  const detector = new RollingDetector({
    params: {
      baselineWindows: 4,
      minSustain: 2,
      minSignals: 2,
      zThreshold: 2,
      triggerThreshold: 3,
      criticalityWeight: 1,
      sigmaFloorRatio: 0.1,
      metrics: ['p99_latency', 'retry_rate', 'error_rate'],
    },
    historyWindows: 20,
    logger: silentLogger,
  })

  const savedAt = Date.UTC(2024, 0, 1, 12, 0, 0)
  detector.hydrateBuffers([
    {
      service: 'api',
      samples: [
        { service: 'api', timestamp: new Date(savedAt - 60_000).toISOString(), p99_latency: 100, retry_rate: 1, error_rate: 0.5 },
        { service: 'api', timestamp: new Date(savedAt).toISOString(), p99_latency: 110, retry_rate: 1, error_rate: 0.5 },
      ],
    },
  ])

  const [fresh] = detector.freshness(savedAt + 120_000)
  assert.equal(fresh.service, 'api')
  // The newest restored sample, not the oldest, and not "never observed".
  assert.equal(fresh.staleSeconds, 120)
})

test('a restored service that never reports again is reported stale, not silently healthy', async () => {
  // The failure this guards: the agent restarts, restores five services, and
  // only four resume reporting. Global freshness stays green on the strength of
  // the four, and without a recorded observation time the fifth is skipped by
  // the per-service check entirely.
  const agent = await agentWith(async () => [goodSample()], {
    detector: { noDataGraceSeconds: 60 },
  })

  const staleAt = Date.now() - 10 * 60_000
  agent.detector.hydrateBuffers([
    {
      service: 'ghost',
      samples: [
        { service: 'ghost', timestamp: new Date(staleAt).toISOString(), p99_latency: 100, retry_rate: 1, error_rate: 0.5 },
      ],
    },
  ])

  await agent.start()

  const health = agent.health()
  assert.equal(health.status, 'degraded')
  assert.ok(health.reasons.includes('service_telemetry_stale'))
  assert.deepEqual(health.staleServices, ['ghost'])

  await agent.stop()
})

test('restoring fresh state does not make a healthy agent look degraded', async () => {
  const agent = await agentWith(async () => [goodSample()], {
    detector: { noDataGraceSeconds: 300 },
  })

  agent.detector.hydrateBuffers([
    {
      service: 'api',
      samples: [
        { service: 'api', timestamp: new Date().toISOString(), p99_latency: 100, retry_rate: 1, error_rate: 0.5 },
      ],
    },
  ])

  await agent.start()

  const health = agent.health()
  assert.equal(health.status, 'ok', `unexpected reasons: ${health.reasons.join(', ')}`)
  assert.deepEqual(health.staleServices, [])

  await agent.stop()
})
