import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { FaultlineAgent, assertSafeExposure } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { createAuthenticator, isLoopbackHost } from '../src/auth.js'
import { silentLogger } from '../src/logger.js'

const buildConfig = async (serverOverrides = {}, env = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-sec-'))
  return loadConfig({
    env,
    overrides: {
      source: { type: 'synthetic', options: {} },
      detector: { intervalSeconds: 3600 },
      alerting: { notifiers: [] },
      server: { enabled: true, port: 0, ...serverOverrides },
      storage: { path: join(dir, 'state.json') },
    },
  })
}

const startAgent = async (serverOverrides = {}, env = {}) => {
  const config = await buildConfig(serverOverrides, env)
  const agent = new FaultlineAgent(config, { logger: silentLogger, env })
  await agent.start()
  const { port } = agent.server.address()
  return { agent, base: `http://127.0.0.1:${port}` }
}

// --- fail closed ------------------------------------------------------------

test('binding beyond loopback with no token refuses to start', async () => {
  const config = await buildConfig({ host: '0.0.0.0' })
  const agent = new FaultlineAgent(config, { logger: silentLogger, env: {} })

  await assert.rejects(() => agent.start(), /Refusing to start/)

  // Nothing may be left listening after a refused start.
  assert.equal(agent.server, null)
})

test('the refusal names both remedies: a token or a loopback bind', () => {
  assert.throws(
    () => assertSafeExposure({ host: '0.0.0.0', auth: { tokenEnv: 'FAULTLINE_API_TOKEN' } }, {}),
    (err) => /FAULTLINE_API_TOKEN/.test(err.message) && /127\.0\.0\.1/.test(err.message)
  )
})

test('every non-loopback form is refused, not just 0.0.0.0', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'example.internal']) {
    assert.throws(() => assertSafeExposure({ host, auth: {} }, {}), /Refusing to start/, `host ${host}`)
  }
})

test('loopback forms are accepted without a token', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.doesNotThrow(() => assertSafeExposure({ host, auth: {} }, {}), `host ${host}`)
    assert.equal(isLoopbackHost(host), true)
  }
})

test('a token permits a non-loopback bind', async () => {
  const env = { FAULTLINE_API_TOKEN: 'secret-token' }
  assert.doesNotThrow(() =>
    assertSafeExposure({ host: '0.0.0.0', auth: { tokenEnv: 'FAULTLINE_API_TOKEN' } }, env)
  )
})

// --- anonymous writes -------------------------------------------------------

test('an anonymous request cannot create a silence on a token-protected agent', async () => {
  const env = { FAULTLINE_API_TOKEN: 'secret-token' }
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, env)

  const res = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ match: '*', reason: 'suppress everything' }),
  })

  assert.equal(res.status, 401)
  assert.equal(agent.silences.list().length, 0, 'no silence may have been created')

  await agent.stop()
})

test('an anonymous request cannot inject faults on a token-protected agent', async () => {
  const env = { FAULTLINE_API_TOKEN: 'secret-token' }
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, env)

  const res = await fetch(`${base}/api/inject?service=checkout-api`, { method: 'POST' })

  assert.equal(res.status, 401)
  await agent.stop()
})

test('a wrong token cannot create a silence', async () => {
  const env = { FAULTLINE_API_TOKEN: 'secret-token' }
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, env)

  const res = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ match: '*', reason: 'nope' }),
  })

  assert.equal(res.status, 401)
  assert.equal(agent.silences.list().length, 0)

  await agent.stop()
})

test('a read-only token cannot create a silence but can read state', async () => {
  const env = { FAULTLINE_API_TOKEN: 'write-token', FAULTLINE_READ_TOKEN: 'read-token' }
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, env)

  const write = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer read-token' },
    body: JSON.stringify({ match: '*', reason: 'nope' }),
  })
  assert.equal(write.status, 403)
  assert.equal(agent.silences.list().length, 0)

  const read = await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer read-token' } })
  assert.equal(read.status, 200)

  await agent.stop()
})

test('the correct token can create and delete a silence', async () => {
  const env = { FAULTLINE_API_TOKEN: 'secret-token' }
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, env)
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' }

  const created = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ match: 'checkout-api', reason: 'planned maintenance', durationSeconds: 60 }),
  })
  assert.equal(created.status, 201)
  const silence = await created.json()

  const removed = await fetch(`${base}/api/silences/${encodeURIComponent(silence.id)}`, {
    method: 'DELETE',
    headers,
  })
  assert.equal(removed.status, 200)

  await agent.stop()
})

// --- defence in depth -------------------------------------------------------

test('the authenticator refuses writes on a non-loopback bind even with auth disabled', () => {
  // Startup should never allow this combination, but if it is ever reached the
  // authorizer must not serve a state-changing route.
  const auth = createAuthenticator({ host: '0.0.0.0', auth: {} }, {})
  const req = { headers: {} }

  assert.equal(auth.enabled, false)
  assert.equal(auth.authorize(req, { write: true })?.status, 401)
  assert.equal(auth.authorize(req, { write: false }), null)
})

test('an unauthenticated loopback agent still serves local writes', async () => {
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, {})

  const res = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ match: 'checkout-api', reason: 'local', durationSeconds: 60 }),
  })

  assert.equal(res.status, 201, 'localhost-only operation stays frictionless')
  await agent.stop()
})

test('health stays anonymous so probes work without a token', async () => {
  const env = { FAULTLINE_API_TOKEN: 'secret-token' }
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, env)

  const res = await fetch(`${base}/health`)
  assert.ok(res.status === 200 || res.status === 503)

  const state = await fetch(`${base}/api/state`)
  assert.equal(state.status, 401, 'telemetry still requires a token')

  await agent.stop()
})

// --- browser attacks on a token-less loopback agent -------------------------
//
// "Bound to loopback" stops other machines, not other websites. A page open in
// the operator's browser can send requests to 127.0.0.1, so the loopback
// default has to defend against cross-site requests and DNS rebinding itself.

// Sends a request with headers fetch() would not let a test control (Host).
const rawRequest = (base, { method = 'GET', path = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base)
    const req = httpRequest({ hostname, port, method, path, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })

test('a cross-site "simple" POST cannot silence a token-less agent', async () => {
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, {})

  // text/plain is exactly what a hostile page can send without a preflight.
  const res = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ match: '*', reason: 'csrf' }),
  })

  assert.equal(res.status, 403)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  assert.equal(agent.silences.list().length, 0, 'no silence may have been created')
  await agent.stop()
})

test('a cross-site request cannot inject faults on a token-less agent', async () => {
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, {})
  const res = await fetch(`${base}/api/inject?service=checkout-api`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(res.status, 403)
  await agent.stop()
})

test('creating a silence requires a JSON content type', async () => {
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, {})
  const res = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ match: '*' }),
  })
  assert.equal(res.status, 415)
  assert.equal(agent.silences.list().length, 0)
  await agent.stop()
})

test('a token-less agent refuses a non-loopback Host header (DNS rebinding)', async () => {
  const { agent, base } = await startAgent({ host: '127.0.0.1' }, {})

  const rebound = await rawRequest(base, { path: '/api/state', headers: { Host: 'evil.example:8787' } })
  assert.equal(rebound.status, 421)

  const local = await rawRequest(base, { path: '/api/state', headers: { Host: 'localhost:8787' } })
  assert.equal(local.status, 200)

  const health = await rawRequest(base, { path: '/health', headers: { Host: 'evil.example' } })
  assert.notEqual(health.status, 421, 'health stays reachable for probes')
  await agent.stop()
})

test('an origin listed in corsOrigin may read and write', async () => {
  const origin = 'http://localhost:5173'
  const { agent, base } = await startAgent({ host: '127.0.0.1', corsOrigin: [origin] }, {})

  const read = await fetch(`${base}/api/state`, { headers: { Origin: origin } })
  assert.equal(read.headers.get('access-control-allow-origin'), origin)

  const write = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ match: 'checkout-api' }),
  })
  assert.equal(write.status, 201)
  await agent.stop()
})

test('a wildcard corsOrigin allows browser reads but never browser writes', async () => {
  const { agent, base } = await startAgent({ host: '127.0.0.1', corsOrigin: '*' }, {})

  const read = await fetch(`${base}/api/state`, { headers: { Origin: 'https://anywhere.example' } })
  assert.equal(read.headers.get('access-control-allow-origin'), '*')

  const write = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { Origin: 'https://anywhere.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ match: '*' }),
  })
  assert.equal(write.status, 403)
  assert.equal(agent.silences.list().length, 0)
  await agent.stop()
})

test('a malformed corsOrigin is a startup error', async () => {
  await assert.rejects(() => buildConfig({ corsOrigin: 5 }), /server\.corsOrigin/)
  await assert.rejects(() => buildConfig({ corsOrigin: [] }), /server\.corsOrigin/)
})
