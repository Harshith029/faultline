import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

const webhookReceiver = () =>
  new Promise((resolve) => {
    const received = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received.push({ path: req.url, payload: JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
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

test('end to end: detect a cascade, alert a webhook, persist the incident, then resolve', async () => {
  const hook = await webhookReceiver()
  const dir = await mkdtemp(join(tmpdir(), 'faultline-e2e-'))
  const statePath = join(dir, 'state.json')

  const config = loadConfig({
    env: {},
    overrides: {
      agent: { name: 'e2e-agent' },
      source: {
        type: 'synthetic',
        options: {
          seed: 7,
          incident: { service: 'checkout-api', startAfterWindows: 12 },
          rampWindows: 8,
          holdWindows: 6,
          recoverWindows: 6,
        },
      },
      detector: { intervalSeconds: 3600, baselineWindows: 8, minSustain: 2, historyWindows: 80 },
      alerting: {
        cooldownSeconds: 0,
        resolveAfterWindows: 3,
        notifiers: [{ type: 'webhook', url: hook.url }, { type: 'file', path: join(dir, 'alerts.jsonl') }],
      },
      server: { enabled: false },
      storage: { path: statePath },
    },
  })

  const agent = new FaultlineAgent(config, { logger: silentLogger })

  try {
    await agent.start()
    for (let i = 0; i < 45; i++) await agent.tick()

    const opened = hook.received.filter((r) => r.payload.event === 'incident.opened')
    const resolved = hook.received.filter((r) => r.payload.event === 'incident.resolved')

    assert.equal(opened.length, 1, 'exactly one alert should fire for one cascade')
    assert.equal(resolved.length, 1, 'the incident should resolve once telemetry recovers')

    const alert = opened[0].payload
    assert.equal(alert.incident.service, 'checkout-api')
    assert.ok(alert.incident.triggerR >= 3)
    assert.match(alert.text, /FAULTLINE/)
    assert.match(alert.text, /checkout-api/)
    assert.ok(['warning', 'critical'].includes(alert.severity))

    assert.equal(resolved[0].payload.incident.id, alert.incident.id)
    assert.equal(resolved[0].payload.incident.status, 'resolved')
    assert.ok(resolved[0].payload.incident.peakR >= alert.incident.triggerR)

    await agent.store.flush()
    const persisted = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(persisted.incidents.length, 1)
    assert.equal(persisted.incidents[0].id, alert.incident.id)
    assert.equal(persisted.incidents[0].status, 'resolved')

    const alertLog = await readFile(join(dir, 'alerts.jsonl'), 'utf8')
    assert.equal(alertLog.trim().split('\n').length, 2)
  } finally {
    await agent.stop()
    await hook.close()
  }
})

test('a failing notifier never stops detection or crashes the agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-e2e-fail-'))
  const config = loadConfig({
    env: {},
    overrides: {
      source: {
        type: 'synthetic',
        options: { seed: 7, incident: { service: 'checkout-api', startAfterWindows: 10 } },
      },
      detector: { intervalSeconds: 3600, baselineWindows: 8, minSustain: 2, historyWindows: 60 },
      alerting: {
        cooldownSeconds: 0,
        resolveAfterWindows: 3,
        // Nothing is listening on this port.
        notifiers: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook', timeoutMs: 200 }],
      },
      server: { enabled: false },
      storage: { path: join(dir, 'state.json') },
    },
  })

  const agent = new FaultlineAgent(config, { logger: silentLogger })
  try {
    await agent.start()
    for (let i = 0; i < 30; i++) await agent.tick()
    assert.ok(agent.store.stats().total >= 1, 'the incident is still recorded when alerting fails')
    assert.equal(agent.snapshot().running, true)
  } finally {
    await agent.stop()
  }
})

test('a broken source degrades health instead of killing the agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-e2e-src-'))
  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'http', options: { url: 'http://127.0.0.1:1/metrics', timeoutMs: 200 } },
      detector: { intervalSeconds: 3600 },
      alerting: { notifiers: [] },
      server: { enabled: false },
      storage: { path: join(dir, 'state.json') },
    },
  })

  const agent = new FaultlineAgent(config, { logger: silentLogger })
  try {
    await agent.start()
    await agent.tick()
    await agent.tick()
    const snapshot = agent.snapshot()
    assert.ok(snapshot.collectErrors >= 2)
    assert.ok(snapshot.consecutiveCollectErrors >= 2)
    assert.equal(snapshot.running, true)
    assert.equal(snapshot.services.length, 0)
  } finally {
    await agent.stop()
  }
})
