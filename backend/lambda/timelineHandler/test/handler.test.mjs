import test from 'node:test'
import assert from 'node:assert/strict'
import { createHandler, isValidHypothesis, buildPrompt } from '../handler.js'

/** Minimal stand-in for an AWS SDK client: records commands, replays queued responses. */
const fakeClient = (responses = []) => {
  const queue = [...responses]
  const sent = []
  return {
    sent,
    async send(command) {
      sent.push(command)
      if (queue.length === 0) throw new Error('unexpected extra call')
      const next = queue.shift()
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(command) : next
    },
  }
}

const ddbWindow = (n, extra = {}) => ({
  service_id: { S: 'B' },
  window_number: { N: String(n) },
  window_timestamp: { S: `2024-01-01T00:${String(n).padStart(2, '0')}:00Z` },
  metrics: { M: { p99_latency_z: { N: '1.1' } } },
  qualified_signals: { L: [] },
  signal_count: { N: '0' },
  R_score: { N: '0.5' },
  confidence: { N: '0.2' },
  triggered: { BOOL: false },
  outage: { BOOL: false },
  ...extra,
})

const triggeredDdbWindow = (n) =>
  ddbWindow(n, {
    triggered: { BOOL: true },
    R_score: { N: '3.96' },
    signal_count: { N: '2' },
    qualified_signals: {
      L: [
        { M: { metric: { S: 'p99_latency_z' }, z_score: { N: '3.2' }, windows_sustained: { N: '3' } } },
        { M: { metric: { S: 'error_rate_z' }, z_score: { N: '2.4' }, windows_sustained: { N: '2' } } },
      ],
    },
    hypothesis_fallback: {
      M: {
        root_service: { S: 'B' },
        mechanism: { S: 'deterministic fallback' },
        cascade_path: { S: 'B' },
        evidence: { L: [{ S: 'e1' }, { S: 'e2' }, { S: 'e3' }] },
      },
    },
  })

const bedrockReply = (obj) => ({
  body: new TextEncoder().encode(
    JSON.stringify({ content: [{ text: JSON.stringify(obj) }] })
  ),
})

const parse = (res) => JSON.parse(res.body)

// --- request validation -----------------------------------------------------

test('a missing service_id is rejected before any AWS call is made', async () => {
  const dynamo = fakeClient()
  const handler = createHandler({ dynamo, env: {}, log: () => {} })

  const res = await handler({ queryStringParameters: {} })

  assert.equal(res.statusCode, 400)
  assert.equal(dynamo.sent.length, 0)
})

test('a service_id with unsafe characters is rejected', async () => {
  const dynamo = fakeClient()
  const handler = createHandler({ dynamo, env: {}, log: () => {} })

  const res = await handler({ queryStringParameters: { service_id: 'B; DROP' } })

  assert.equal(res.statusCode, 400)
  assert.equal(dynamo.sent.length, 0)
})

// --- DynamoDB ---------------------------------------------------------------

test('an empty timeline is a 404, not an empty success', async () => {
  const dynamo = fakeClient([{ Items: [] }])
  const handler = createHandler({ dynamo, env: { TABLE_NAME: 't' }, log: () => {} })

  const res = await handler({ queryStringParameters: { service_id: 'B' } })

  assert.equal(res.statusCode, 404)
})

test('windows are returned sorted by window number', async () => {
  const dynamo = fakeClient([{ Items: [ddbWindow(3), ddbWindow(1), ddbWindow(2)] }])
  const handler = createHandler({ dynamo, env: { TABLE_NAME: 't' }, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.deepEqual(body.windows.map((w) => w.window_number), [1, 2, 3])
})

test('a DynamoDB failure surfaces as 502 rather than an unhandled rejection', async () => {
  const dynamo = fakeClient([new Error('ProvisionedThroughputExceeded')])
  const handler = createHandler({ dynamo, env: { TABLE_NAME: 't' }, log: () => {} })

  const res = await handler({ queryStringParameters: { service_id: 'B' } })

  assert.equal(res.statusCode, 502)
  assert.equal(parse(res).error, 'timeline unavailable')
})

// --- DynamoDB pagination ----------------------------------------------------

test('pagination follows LastEvaluatedKey so a long timeline is not truncated', async () => {
  const dynamo = fakeClient([
    { Items: [ddbWindow(1), ddbWindow(2)], LastEvaluatedKey: { service_id: { S: 'B' }, window_number: { N: '2' } } },
    { Items: [ddbWindow(3), ddbWindow(4)], LastEvaluatedKey: { service_id: { S: 'B' }, window_number: { N: '4' } } },
    { Items: [ddbWindow(5)] },
  ])
  const handler = createHandler({ dynamo, env: { TABLE_NAME: 't' }, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.equal(body.windows.length, 5)
  assert.equal(body.meta.pages_fetched, 3)
  assert.equal(body.meta.truncated, false)
})

test('the second page request carries ExclusiveStartKey', async () => {
  const key = { service_id: { S: 'B' }, window_number: { N: '2' } }
  const dynamo = fakeClient([{ Items: [ddbWindow(1)], LastEvaluatedKey: key }, { Items: [ddbWindow(2)] }])
  const handler = createHandler({ dynamo, env: { TABLE_NAME: 't' }, log: () => {} })

  await handler({ queryStringParameters: { service_id: 'B' } })

  assert.equal(dynamo.sent[0].input.ExclusiveStartKey, undefined)
  assert.deepEqual(dynamo.sent[1].input.ExclusiveStartKey, key)
})

test('a timeline longer than the page cap reports itself as truncated', async () => {
  const page = () => ({
    Items: [ddbWindow(1)],
    LastEvaluatedKey: { service_id: { S: 'B' }, window_number: { N: '1' } },
  })
  const dynamo = fakeClient(Array.from({ length: 25 }, page))
  const handler = createHandler({ dynamo, env: { TABLE_NAME: 't' }, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.equal(body.meta.truncated, true)
  assert.equal(body.meta.pages_fetched, 20)
})

// --- Bedrock ----------------------------------------------------------------

const validGenerated = {
  root_service: 'B',
  mechanism: 'Latency and error z-scores rose together, consistent with saturation.',
  cascade_path: 'B',
  evidence: [
    'p99_latency_z sustained 3 windows',
    'error_rate_z sustained 2 windows',
    'p99_latency_z and error_rate_z converged at R score 3.96',
  ],
}

test('a valid Bedrock hypothesis replaces the fallback and is attributed', async () => {
  const dynamo = fakeClient([{ Items: [triggeredDdbWindow(1)] }])
  const bedrock = fakeClient([bedrockReply(validGenerated)])
  const handler = createHandler({
    dynamo,
    bedrock,
    env: { TABLE_NAME: 't', BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0' },
    log: () => {},
  })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.equal(body.windows[0].hypothesis.mechanism, validGenerated.mechanism)
  assert.equal(body.windows[0].hypothesis.generated_by, 'bedrock')
  assert.equal(body.windows[0].hypothesis.scope, 'single_service_drift')
  assert.equal(body.windows[0].hypothesis.model_id, 'anthropic.claude-3-haiku-20240307-v1:0')
})

test('Bedrock is never called when no model is configured', async () => {
  const dynamo = fakeClient([{ Items: [triggeredDdbWindow(1)] }])
  const bedrock = fakeClient()
  const handler = createHandler({ dynamo, bedrock, env: { TABLE_NAME: 't' }, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.equal(bedrock.sent.length, 0)
  assert.equal(body.windows[0].hypothesis.mechanism, 'deterministic fallback')
})

test('a Bedrock error falls back to the deterministic hypothesis', async () => {
  const dynamo = fakeClient([{ Items: [triggeredDdbWindow(1)] }])
  const bedrock = fakeClient([new Error('AccessDeniedException')])
  const handler = createHandler({
    dynamo,
    bedrock,
    env: { TABLE_NAME: 't', BEDROCK_MODEL_ID: 'm' },
    log: () => {},
  })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.equal(body.windows[0].hypothesis.mechanism, 'deterministic fallback')
})

test('malformed Bedrock output falls back instead of returning garbage', async () => {
  const dynamo = fakeClient([{ Items: [triggeredDdbWindow(1)] }])
  const bedrock = fakeClient([{ body: new TextEncoder().encode('not json at all') }])
  const handler = createHandler({
    dynamo,
    bedrock,
    env: { TABLE_NAME: 't', BEDROCK_MODEL_ID: 'm' },
    log: () => {},
  })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.equal(body.windows[0].hypothesis.mechanism, 'deterministic fallback')
})

test('a hypothesis naming a service the detector never evaluated is rejected', async () => {
  const dynamo = fakeClient([{ Items: [triggeredDdbWindow(1)] }])
  const bedrock = fakeClient([bedrockReply({ ...validGenerated, root_service: 'service-q' })])
  const handler = createHandler({
    dynamo,
    bedrock,
    env: { TABLE_NAME: 't', BEDROCK_MODEL_ID: 'm' },
    log: () => {},
  })

  const body = parse(await handler({ queryStringParameters: { service_id: 'B' } }))

  assert.equal(body.windows[0].hypothesis.mechanism, 'deterministic fallback')
})

test('a windows list with no trigger never invokes Bedrock', async () => {
  const dynamo = fakeClient([{ Items: [ddbWindow(1), ddbWindow(2)] }])
  const bedrock = fakeClient()
  const handler = createHandler({
    dynamo,
    bedrock,
    env: { TABLE_NAME: 't', BEDROCK_MODEL_ID: 'm' },
    log: () => {},
  })

  const res = await handler({ queryStringParameters: { service_id: 'B' } })

  assert.equal(res.statusCode, 200)
  assert.equal(bedrock.sent.length, 0)
})

test('the prompt forbids naming any service other than the evaluated one', () => {
  const prompt = buildPrompt({
    service_id: 'B',
    window_number: 8,
    qualified_signals: [{ metric: 'p99_latency_z', z_score: 3.2, windows_sustained: 3 }],
    metrics: { p99_latency_z: 3.2 },
  })

  assert.match(prompt, /Do not name any service other than "B"/)
  assert.match(prompt, /no dependency graph/)
  // The old prompt demanded a Unicode arrow cascade path the UI could not parse.
  assert.doesNotMatch(prompt, /must use → symbol/)
})

test('hypothesis validation requires grounded evidence for exactly one evaluated service', () => {
  const w = {
    service_id: 'B',
    qualified_signals: [{ metric: 'p99_latency_z' }, { metric: 'error_rate_z' }],
  }
  assert.equal(isValidHypothesis(validGenerated, w), true)
  assert.equal(isValidHypothesis({ ...validGenerated, evidence: ['a', 'b'] }, w), false)
  assert.equal(isValidHypothesis({ ...validGenerated, evidence: ['a', 'b', '  '] }, w), false)
  assert.equal(
    isValidHypothesis({ ...validGenerated, evidence: ['p99_latency_z', 'error_rate_z', 'invented evidence'] }, w),
    false
  )
  assert.equal(isValidHypothesis({ ...validGenerated, cascade_path: 'B -> service-q' }, w), false)
  assert.equal(isValidHypothesis({ ...validGenerated, mechanism: '' }, w), false)
  assert.equal(isValidHypothesis(null, w), false)
})

// --- CloudWatch live path ---------------------------------------------------

const cwResult = (points) => ({
  MetricDataResults: [
    { Id: 'latency', Timestamps: points.map((p) => p.t), Values: points.map((p) => p.latency) },
    { Id: 'client_errors', Timestamps: points.map((p) => p.t), Values: points.map((p) => p.client) },
    { Id: 'server_errors', Timestamps: points.map((p) => p.t), Values: points.map((p) => p.server) },
  ],
})

const NOW = Date.UTC(2024, 0, 1, 12, 0, 0)
const minuteBefore = (n) => new Date(NOW - n * 60000)

test('live telemetry maps CloudWatch datapoints into complete windows', async () => {
  const points = [
    { t: minuteBefore(3), latency: 120.456, client: 0.02, server: 0.01 },
    { t: minuteBefore(2), latency: 130, client: 0.03, server: 0.02 },
  ]
  const cloudwatch = fakeClient([cwResult(points)])
  const handler = createHandler({ cloudwatch, env: { LIVE_API_NAME: 'my-api' }, now: () => NOW, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { source: 'live' } }))

  assert.equal(body.source, 'cloudwatch')
  assert.equal(body.api_name, 'my-api')
  assert.equal(body.raw.length, 2)
  assert.equal(body.raw[0].p99_latency, 120.46)
  assert.equal(body.raw[0].client_error_rate, 2)
})

test('the 4XX-derived metric is not called a retry rate', async () => {
  const cloudwatch = fakeClient([cwResult([{ t: minuteBefore(1), latency: 1, client: 0, server: 0 }])])
  const handler = createHandler({ cloudwatch, env: {}, now: () => NOW, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { source: 'live' } }))

  assert.ok(!('retry_rate' in body.raw[0]), 'raw windows must not expose retry_rate')
  assert.ok(!('retry_rate' in body.metric_mapping))
  assert.match(body.metric_mapping.client_error_rate, /Not a retry count/)
  assert.deepEqual(body.metrics, ['p99_latency', 'client_error_rate', 'error_rate'])
})

test('a window missing any metric is reported as a gap, never zero-filled', async () => {
  const cloudwatch = fakeClient([
    {
      MetricDataResults: [
        { Id: 'latency', Timestamps: [minuteBefore(3), minuteBefore(2)], Values: [120, 130] },
        // The 4XX series has no datapoint for the first window.
        { Id: 'client_errors', Timestamps: [minuteBefore(2)], Values: [0.03] },
        { Id: 'server_errors', Timestamps: [minuteBefore(3), minuteBefore(2)], Values: [0.01, 0.02] },
      ],
    },
  ])
  const handler = createHandler({ cloudwatch, env: {}, now: () => NOW, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { source: 'live' } }))

  assert.equal(body.raw.length, 1, 'only the complete window is returned')
  assert.equal(body.data_quality.windows_incomplete, 59)
  assert.deepEqual(body.data_quality.gaps[0].missing, ['p99_latency', 'client_error_rate', 'error_rate'])
  // The incomplete window must not appear as a zero observation.
  assert.ok(body.raw.every((w) => w.p99_latency !== 0 || w.error_rate !== 0 || w.client_error_rate !== 0))
})

test('non-finite CloudWatch values are treated as missing, not as zero', async () => {
  const cloudwatch = fakeClient([
    {
      MetricDataResults: [
        { Id: 'latency', Timestamps: [minuteBefore(2)], Values: [null] },
        { Id: 'client_errors', Timestamps: [minuteBefore(2)], Values: [0.03] },
        { Id: 'server_errors', Timestamps: [minuteBefore(2)], Values: [0.02] },
      ],
    },
  ])
  const handler = createHandler({ cloudwatch, env: {}, now: () => NOW, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { source: 'live' } }))

  assert.equal(body.raw.length, 0)
  assert.equal(body.data_quality.windows_complete, 0)
})

test('an empty CloudWatch response yields zero windows and says so', async () => {
  const cloudwatch = fakeClient([{ MetricDataResults: [] }])
  const handler = createHandler({ cloudwatch, env: {}, now: () => NOW, log: () => {} })

  const body = parse(await handler({ queryStringParameters: { source: 'live' } }))

  assert.equal(body.raw.length, 0)
  assert.equal(body.data_quality.windows_complete, 0)
  assert.equal(body.data_quality.windows_incomplete, 60)
})

test('a CloudWatch failure surfaces as 502', async () => {
  const cloudwatch = fakeClient([new Error('AccessDenied: cloudwatch:GetMetricData')])
  const handler = createHandler({ cloudwatch, env: {}, now: () => NOW, log: () => {} })

  const res = await handler({ queryStringParameters: { source: 'live' } })

  assert.equal(res.statusCode, 502)
  assert.equal(parse(res).error, 'live telemetry unavailable')
})

test('the live query asks CloudWatch for the configured API name only', async () => {
  const cloudwatch = fakeClient([cwResult([])])
  const handler = createHandler({ cloudwatch, env: { LIVE_API_NAME: 'checkout-api' }, now: () => NOW, log: () => {} })

  await handler({ queryStringParameters: { source: 'live' } })

  const queries = cloudwatch.sent[0].input.MetricDataQueries
  assert.equal(queries.length, 3)
  for (const q of queries) {
    assert.equal(q.MetricStat.Metric.Namespace, 'AWS/ApiGateway')
    assert.deepEqual(q.MetricStat.Metric.Dimensions, [{ Name: 'ApiName', Value: 'checkout-api' }])
  }
})
