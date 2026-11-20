import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

// A webhook that answers with the next status in `statuses`, then 200 forever.
const flakyWebhook = (statuses = []) =>
  new Promise((resolve) => {
    const received = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push(JSON.parse(body).event)
        res.writeHead(statuses.shift() ?? 200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({
        received,
        url: `http://127.0.0.1:${server.address().port}/hook`,
        close: () => new Promise((r) => server.close(r)),
      })
    )
  })

const fileEvents = async (path) => {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).type)
  } catch {
    return []
  }
}

const makeAgent = async ({ hookUrl, cooldownSeconds = 0 }) => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-delivery-'))
  const alertsPath = join(dir, 'alerts.jsonl')
  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'synthetic', options: {} },
      detector: { intervalSeconds: 3600, baselineWindows: 4, minSustain: 2, historyWindows: 20 },
      alerting: {
        cooldownSeconds,
        resolveAfterWindows: 2,
        notifiers: [
          { type: 'webhook', url: hookUrl, timeoutMs: 2000 },
          { type: 'file', path: alertsPath },
        ],
      },
      server: { enabled: false },
      storage: { path: join(dir, 'state.json'), snapshotEveryTicks: 1000 },
    },
  })
  const agent = new FaultlineAgent(config, { logger: silentLogger, env: {} })
  const control = { spike: false }
  agent.source = {
    name: 'stub',
    collect: async () => [
      {
        service: 'api',
        p99_latency: control.spike ? 900 : 120,
        retry_rate: control.spike ? 14 : 1,
        error_rate: control.spike ? 11 : 0.4,
      },
    ],
    state: () => ({}),
  }
  return { agent, control, alertsPath }
}

const tickUntil = async (agent, predicate, max = 20) => {
  for (let i = 0; i < max; i++) {
    await agent.tick()
    if (predicate()) return
  }
  throw new Error('condition never reached')
}

test('a failed webhook is not recorded as delivered, and is retried next window', async () => {
  const hook = await flakyWebhook([500])
  const { agent, control, alertsPath } = await makeAgent({ hookUrl: hook.url })
  try {
    for (let i = 0; i < 5; i++) await agent.tick()
    control.spike = true
    await tickUntil(agent, () => agent.store.stats().total > 0)

    const opened = agent.store.getIncidents()[0]
    assert.equal(opened.notifiedAt, undefined, 'a 500 from the webhook must not count as delivery')
    assert.deepEqual(opened.deliveredTo, ['1:file'], 'the file sink did receive it')

    await agent.tick()
    const retried = agent.store.getIncidents()[0]
    assert.ok(retried.notifiedAt, 'the retry succeeded, so the incident is now fully delivered')
    assert.deepEqual(hook.received, ['incident.opened', 'incident.opened'])
    assert.deepEqual(await fileEvents(alertsPath), ['incident.opened'], 'the sink that already had it is not re-paged')
  } finally {
    await agent.stop()
    await hook.close()
  }
})

test('a resolve goes only to the sinks that received the open', async () => {
  const hook = await flakyWebhook(Array(50).fill(503))
  const { agent, control, alertsPath } = await makeAgent({ hookUrl: hook.url })
  try {
    for (let i = 0; i < 5; i++) await agent.tick()
    control.spike = true
    await tickUntil(agent, () => agent.store.stats().total > 0)
    await agent.tick()
    control.spike = false
    await tickUntil(agent, () => agent.store.stats().resolved > 0)

    assert.ok(hook.received.every((e) => e === 'incident.opened'), 'the dead webhook never gets a resolve for an open it never had')
    assert.deepEqual(await fileEvents(alertsPath), ['incident.opened', 'incident.resolved'])
    assert.equal(agent.store.getIncidents()[0].notifiedAt, undefined)
  } finally {
    await agent.stop()
    await hook.close()
  }
})

test('a re-trigger during the cooldown is recorded, held, and paged once the hold ends', async () => {
  const hook = await flakyWebhook()
  const { agent, control } = await makeAgent({ hookUrl: hook.url, cooldownSeconds: 3600 })
  try {
    for (let i = 0; i < 5; i++) await agent.tick()
    control.spike = true
    await tickUntil(agent, () => agent.store.stats().total === 1)
    control.spike = false
    await tickUntil(agent, () => agent.store.stats().resolved === 1)
    assert.deepEqual(hook.received, ['incident.opened', 'incident.resolved'])

    control.spike = true
    await tickUntil(agent, () => agent.store.stats().total === 2)
    const held = agent.store.getIncidents()[0]
    assert.ok(held.heldUntil, 'the flap is in the history, marked as held')
    assert.equal(held.notifiedAt, undefined)
    await agent.tick()
    assert.equal(hook.received.length, 2, 'nothing is paged while the cooldown holds it')

    // Simulate the cooldown elapsing while the service is still firing.
    agent.alerts.stateFor('api').incident.heldUntil = new Date(Date.now() - 1000).toISOString()
    await agent.tick()
    assert.deepEqual(hook.received, ['incident.opened', 'incident.resolved', 'incident.opened'])
  } finally {
    await agent.stop()
    await hook.close()
  }
})
