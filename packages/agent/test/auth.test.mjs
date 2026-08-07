import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthenticator, extractToken } from '../src/auth.js'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

const req = (headers = {}) => ({ headers })

test('tokens are read from Authorization or X-API-Key', () => {
  assert.equal(extractToken(req({ authorization: 'Bearer abc' })), 'abc')
  assert.equal(extractToken(req({ authorization: 'bearer  abc ' })), 'abc')
  assert.equal(extractToken(req({ 'x-api-key': 'xyz' })), 'xyz')
  assert.equal(extractToken(req({ authorization: 'Basic abc' })), null)
  assert.equal(extractToken(req()), null)
})

test('with no token configured the API stays open', () => {
  const auth = createAuthenticator({}, {})
  assert.equal(auth.enabled, false)
  assert.equal(auth.authorize(req(), { write: true }), null)
})

test('a configured token is required for reads and writes', () => {
  const auth = createAuthenticator({ auth: { tokenEnv: 'T' } }, { T: 'secret' })
  assert.equal(auth.enabled, true)
  assert.equal(auth.authorize(req({ authorization: 'Bearer secret' }), {}), null)
  assert.equal(auth.authorize(req(), {}).status, 401)
  assert.equal(auth.authorize(req({ authorization: 'Bearer wrong' }), {}).status, 401)
})

test('a read-only token can read but not write', () => {
  const auth = createAuthenticator(
    { auth: { tokenEnv: 'T', readOnlyTokenEnv: 'R' } },
    { T: 'full', R: 'readonly' }
  )
  assert.equal(auth.authorize(req({ authorization: 'Bearer readonly' }), { write: false }), null)
  const refusal = auth.authorize(req({ authorization: 'Bearer readonly' }), { write: true })
  assert.equal(refusal.status, 403, 'a valid token on a forbidden route is 403, not 401')
  assert.match(refusal.error, /read-only/)
})

test('allowAnonymousRead opens reads but still guards writes', () => {
  const auth = createAuthenticator(
    { auth: { tokenEnv: 'T', allowAnonymousRead: true } },
    { T: 'secret' }
  )
  assert.equal(auth.authorize(req(), { write: false }), null)
  assert.equal(auth.authorize(req(), { write: true }).status, 401)
})

test('anonymous routes bypass auth entirely', () => {
  const auth = createAuthenticator({ auth: { tokenEnv: 'T' } }, { T: 'secret' })
  assert.equal(auth.authorize(req(), { anonymous: true }), null)
})

test('tokens of differing length are rejected without throwing', () => {
  const auth = createAuthenticator({ auth: { tokenEnv: 'T' } }, { T: 'a-long-secret-value' })
  assert.equal(auth.authorize(req({ authorization: 'Bearer x' }), {}).status, 401)
})

test('config refuses literal tokens so credentials stay out of files', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { server: { auth: { token: 'hunter2' } } } }),
    /must not contain literal tokens/
  )
})

test('config validates TLS and auth shapes', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { server: { tls: { certFile: 'c.pem' } } } }),
    /requires both "certFile" and "keyFile"/
  )
  assert.throws(
    () => loadConfig({ env: {}, overrides: { server: { auth: { allowAnonymousRead: 'yes' } } } }),
    /allowAnonymousRead must be a boolean/
  )
})

test('a TLS misconfiguration fails startup instead of silently serving plaintext', async () => {
  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'synthetic' },
      detector: { intervalSeconds: 3600 },
      alerting: { notifiers: [] },
      server: { enabled: true, port: 0, tls: { certFile: '/nope/cert.pem', keyFile: '/nope/key.pem' } },
      storage: { path: join(mkdtempSync(join(tmpdir(), 'faultline-tls-')), 'state.json') },
    },
  })
  const agent = new FaultlineAgent(config, { logger: silentLogger })
  await assert.rejects(agent.start(), /certificate could not be read/)
})

let agent
let base
const TOKEN = 'full-access-token'
const READ = 'read-only-token'

before(async () => {
  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'synthetic', options: { seed: 4 } },
      detector: { intervalSeconds: 3600, baselineWindows: 8, minSustain: 2, historyWindows: 40 },
      alerting: { notifiers: [] },
      server: {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        auth: { tokenEnv: 'FL_TEST_TOKEN', readOnlyTokenEnv: 'FL_TEST_READ' },
      },
      storage: { path: join(mkdtempSync(join(tmpdir(), 'faultline-auth-')), 'state.json') },
    },
  })
  process.env.FL_TEST_TOKEN = TOKEN
  process.env.FL_TEST_READ = READ
  agent = new FaultlineAgent(config, { logger: silentLogger })
  await agent.start()
  base = `http://127.0.0.1:${agent.server.address().port}`
})

after(async () => {
  await agent.stop()
  delete process.env.FL_TEST_TOKEN
  delete process.env.FL_TEST_READ
})

test('health stays anonymous so probes keep working', async () => {
  const res = await fetch(`${base}/health`)
  assert.equal(res.status, 200)
})

test('reads require a token and advertise the scheme when refused', async () => {
  const res = await fetch(`${base}/api/state`)
  assert.equal(res.status, 401)
  assert.match(res.headers.get('www-authenticate'), /Bearer/)

  const ok = await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  assert.equal(ok.status, 200)
})

test('metrics are protected too', async () => {
  assert.equal((await fetch(`${base}/metrics`)).status, 401)
  const ok = await fetch(`${base}/metrics`, { headers: { 'X-API-Key': READ } })
  assert.equal(ok.status, 200)
  assert.match(await ok.text(), /faultline_up 1/)
})

test('a read-only token cannot create a silence', async () => {
  const res = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${READ}` },
    body: JSON.stringify({ match: 'nope' }),
  })
  assert.equal(res.status, 403)
  assert.equal(agent.silences.list().length, 0, 'the silence must not have been created')
})

test('the full token can create and delete a silence', async () => {
  const created = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ match: 'checkout-*', reason: 'deploy' }),
  })
  assert.equal(created.status, 201)
  const silence = await created.json()

  const removed = await fetch(`${base}/api/silences/${silence.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(removed.status, 200)
})

test('an unauthenticated write is rejected', async () => {
  const res = await fetch(`${base}/api/silences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ match: 'anything' }),
  })
  assert.equal(res.status, 401)
})

test('CORS preflight still succeeds and allows the auth headers', async () => {
  const res = await fetch(`${base}/api/state`, { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.match(res.headers.get('access-control-allow-headers'), /Authorization/)
})
