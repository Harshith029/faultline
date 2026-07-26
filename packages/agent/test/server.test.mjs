import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

let agent
let base

before(async () => {
  const config = loadConfig({
    env: {},
    overrides: {
      agent: { name: 'test-agent' },
      source: { type: 'synthetic', options: { seed: 4, incident: { service: 'checkout-api', startAfterWindows: 2 } } },
      detector: { intervalSeconds: 3600, baselineWindows: 8, minSustain: 2, historyWindows: 60 },
      alerting: { cooldownSeconds: 0, resolveAfterWindows: 2, notifiers: [] },
      server: { enabled: true, host: '127.0.0.1', port: 0 },
      storage: { path: join(mkdtempSync(join(tmpdir(), 'faultline-srv-')), 'state.json') },
    },
  })
  agent = new FaultlineAgent(config, { logger: silentLogger })
  await agent.start()
  base = `http://127.0.0.1:${agent.server.address().port}`
  // start() performs one tick; drive enough more to produce a detection.
  for (let i = 0; i < 24; i++) await agent.tick()
})

after(async () => {
  await agent.stop()
})

test('GET /health reports a live agent', async () => {
  const res = await fetch(`${base}/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.agent, 'test-agent')
  assert.equal(body.source, 'synthetic')
  assert.ok(body.ticks >= 24)
  assert.equal(body.servicesTracked, 3)
})

test('GET /api/state exposes per-service risk', async () => {
  const body = await (await fetch(`${base}/api/state`)).json()
  const checkout = body.services.find((s) => s.service === 'checkout-api')
  assert.equal(checkout.status, 'evaluated')
  assert.equal(typeof checkout.R_score, 'number')
  assert.ok(Array.isArray(checkout.qualified_signals))
})

test('GET /api/windows returns engine output for charting', async () => {
  const body = await (await fetch(`${base}/api/windows?service=checkout-api`)).json()
  assert.equal(body.service, 'checkout-api')
  assert.ok(body.windows.length >= 10)
  const window = body.windows.at(-1)
  assert.ok('R_score' in window && 'metrics' in window && 'qualified_signals' in window)
  assert.ok(body.baselines.p99_latency.sigma > 0)
})

test('GET /api/windows validates its input', async () => {
  assert.equal((await fetch(`${base}/api/windows`)).status, 400)
  assert.equal((await fetch(`${base}/api/windows?service=ghost`)).status, 404)
})

test('GET /api/incidents lists the detected incident', async () => {
  const body = await (await fetch(`${base}/api/incidents`)).json()
  assert.ok(body.incidents.length >= 1, 'expected the injected cascade to be recorded')
  const incident = body.incidents[0]
  assert.equal(incident.service, 'checkout-api')
  assert.ok(incident.triggerR >= 3)

  const one = await (await fetch(`${base}/api/incidents/${incident.id}`)).json()
  assert.equal(one.id, incident.id)
  assert.equal((await fetch(`${base}/api/incidents/does-not-exist`)).status, 404)
})

test('GET /metrics emits valid Prometheus exposition format', async () => {
  const res = await fetch(`${base}/metrics`)
  assert.match(res.headers.get('content-type'), /text\/plain/)
  const body = await res.text()
  assert.match(body, /^faultline_up 1$/m)
  assert.match(body, /^faultline_risk_score\{service="checkout-api"\} [\d.]+$/m)
  assert.match(body, /^faultline_service_firing\{service="[^"]+"\} [01]$/m)
  assert.match(body, /# TYPE faultline_risk_score gauge/)
})

test('POST /api/inject triggers a fault on demand', async () => {
  const res = await fetch(`${base}/api/inject?service=payments`, { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal((await res.json()).service, 'payments')
})

test('unknown routes 404 as JSON', async () => {
  const res = await fetch(`${base}/nope`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'not found')
})

test('CORS preflight is answered so a browser dashboard can read the API', async () => {
  const res = await fetch(`${base}/api/state`, { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
})
