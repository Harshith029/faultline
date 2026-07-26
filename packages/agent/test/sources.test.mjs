import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createSource, createSyntheticSource, createHttpSource, createPrometheusSource } from '../src/sources/index.js'
import { silentLogger } from '../src/logger.js'

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    )
  })

test('unknown source types fail loudly', () => {
  assert.throws(() => createSource({ type: 'nope' }, {}), /Unknown source type/)
})

test('synthetic telemetry is deterministic for a given seed', async () => {
  const a = createSyntheticSource({ seed: 3 }, {})
  const b = createSyntheticSource({ seed: 3 }, {})
  const first = await a.collect()
  const second = await b.collect()
  assert.deepEqual(
    first.map((s) => s.p99_latency),
    second.map((s) => s.p99_latency)
  )
})

test('synthetic baseline stays near the configured level', async () => {
  const source = createSyntheticSource({ seed: 11 }, {})
  for (let i = 0; i < 20; i++) {
    const samples = await source.collect()
    const checkout = samples.find((s) => s.service === 'checkout-api')
    assert.ok(checkout.p99_latency > 80 && checkout.p99_latency < 160, `unexpected baseline ${checkout.p99_latency}`)
  }
})

test('an injected incident raises the target service and leaves others alone', async () => {
  const source = createSyntheticSource({ seed: 5 }, { logger: silentLogger })
  for (let i = 0; i < 5; i++) await source.collect()
  const before = (await source.collect()).find((s) => s.service === 'checkout-api')

  source.inject('checkout-api')
  let after = before
  for (let i = 0; i < 12; i++) {
    const samples = await source.collect()
    after = samples.find((s) => s.service === 'checkout-api')
  }
  const untouched = (await source.collect()).find((s) => s.service === 'payments')

  assert.ok(after.p99_latency > before.p99_latency + 40, `latency did not climb: ${before.p99_latency} -> ${after.p99_latency}`)
  assert.ok(untouched.p99_latency < 160, 'unrelated service should stay nominal')
})

test('synthetic reports its incident state', async () => {
  const source = createSyntheticSource({ seed: 1 }, { logger: silentLogger })
  source.inject('payments')
  await source.collect()
  const state = source.state()
  assert.equal(state.incidents[0].service, 'payments')
  assert.ok(state.services.includes('checkout-api'))
})

test('http source maps a JSON payload into samples', async () => {
  const { url, close } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([{ svc: 'api', latency: 130, retries: 0.9, errors: 0.4 }]))
  })
  try {
    const source = createHttpSource(
      { url, mapping: { service: 'svc', p99_latency: 'latency', retry_rate: 'retries', error_rate: 'errors' } },
      { logger: silentLogger }
    )
    const samples = await source.collect()
    assert.equal(samples.length, 1)
    assert.equal(samples[0].service, 'api')
    assert.equal(samples[0].p99_latency, 130)
    assert.equal(samples[0].error_rate, 0.4)
  } finally {
    close()
  }
})

test('http source accepts a { samples: [...] } envelope', async () => {
  const { url, close } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ samples: [{ service: 'api', p99_latency: 1, retry_rate: 2, error_rate: 3 }] }))
  })
  try {
    const samples = await createHttpSource({ url }, { logger: silentLogger }).collect()
    assert.equal(samples[0].service, 'api')
  } finally {
    close()
  }
})

test('http source surfaces transport and shape errors', async () => {
  const { url, close } = await listen((req, res) => {
    res.writeHead(500)
    res.end('boom')
  })
  try {
    await assert.rejects(createHttpSource({ url }, { logger: silentLogger }).collect(), /responded 500/)
  } finally {
    close()
  }

  const bad = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ nope: true }))
  })
  try {
    await assert.rejects(createHttpSource({ url: bad.url }, { logger: silentLogger }).collect(), /must return an array/)
  } finally {
    bad.close()
  }
})

test('http source requires a url', () => {
  assert.throws(() => createHttpSource({}, {}), /requires "url"/)
})

test('prometheus source groups instant vectors by service label', async () => {
  const { url, close } = await listen((req, res) => {
    const query = new URL(req.url, 'http://x').searchParams.get('query')
    const value = query.includes('duration') ? '140' : query.includes('retries') ? '1.2' : '0.5'
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { service: 'checkout' }, value: [1700000000, value] },
            { metric: { service: 'payments' }, value: [1700000000, value] },
          ],
        },
      })
    )
  })
  try {
    const samples = await createPrometheusSource({ url }, { logger: silentLogger }).collect()
    assert.equal(samples.length, 2)
    const checkout = samples.find((s) => s.service === 'checkout')
    assert.equal(checkout.p99_latency, 140)
    assert.equal(checkout.retry_rate, 1.2)
    assert.equal(checkout.error_rate, 0.5)
  } finally {
    close()
  }
})

test('prometheus source rejects a non-vector response', async () => {
  const { url, close } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] } }))
  })
  try {
    await assert.rejects(
      createPrometheusSource({ url }, { logger: silentLogger }).collect(),
      /Expected an instant vector/
    )
  } finally {
    close()
  }
})

test('cloudwatch source refuses to start without targets', async () => {
  const { createCloudWatchSource } = await import('../src/sources/cloudwatch.js')
  assert.throws(() => createCloudWatchSource({}, {}), /requires "targets"/)
})
