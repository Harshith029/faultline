import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SilenceManager, validateSilence } from '../src/silences.js'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

const at = (iso) => Date.parse(iso)

test('a silence with no time bounds is always active', () => {
  const s = new SilenceManager({ logger: silentLogger })
  s.add({ match: 'api' })
  assert.ok(s.isSilenced('api'))
  assert.equal(s.isSilenced('other'), false)
})

test('globs match services the same way service rules do', () => {
  const s = new SilenceManager({ logger: silentLogger })
  s.add({ match: 'batch-*' })
  assert.ok(s.isSilenced('batch-nightly'))
  assert.equal(s.isSilenced('web-1'), false)
})

test('from/until bound a silence to a window', () => {
  const s = new SilenceManager({ logger: silentLogger })
  s.add({ match: 'api', from: '2026-01-01T10:00:00Z', until: '2026-01-01T12:00:00Z' })
  assert.equal(s.isSilenced('api', at('2026-01-01T09:59:00Z')), false)
  assert.ok(s.isSilenced('api', at('2026-01-01T11:00:00Z')))
  assert.equal(s.isSilenced('api', at('2026-01-01T12:01:00Z')), false)
})

test('a daily window recurs and respects its end boundary', () => {
  const s = new SilenceManager({ logger: silentLogger })
  s.add({ match: 'batch', daily: { start: '02:00', end: '04:00' } })
  assert.ok(s.isSilenced('batch', at('2026-03-05T02:30:00Z')))
  assert.ok(s.isSilenced('batch', at('2026-06-11T03:59:00Z')))
  assert.equal(s.isSilenced('batch', at('2026-03-05T04:00:00Z')), false)
  assert.equal(s.isSilenced('batch', at('2026-03-05T01:59:00Z')), false)
})

test('a daily window that crosses midnight still works', () => {
  const s = new SilenceManager({ logger: silentLogger })
  s.add({ match: 'batch', daily: { start: '22:00', end: '02:00' } })
  assert.ok(s.isSilenced('batch', at('2026-03-05T22:30:00Z')))
  assert.ok(s.isSilenced('batch', at('2026-03-06T01:30:00Z')))
  assert.equal(s.isSilenced('batch', at('2026-03-06T03:00:00Z')), false)
})

test('days restrict a window to chosen weekdays', () => {
  const s = new SilenceManager({ logger: silentLogger })
  // 2026-03-07 is a Saturday, 2026-03-09 a Monday.
  s.add({ match: 'batch', daily: { start: '00:00', end: '23:59' }, days: [6] })
  assert.ok(s.isSilenced('batch', at('2026-03-07T12:00:00Z')))
  assert.equal(s.isSilenced('batch', at('2026-03-09T12:00:00Z')), false)
})

test('config silences are listed but cannot be removed at runtime', () => {
  const s = new SilenceManager({
    configSilences: [{ match: 'batch-*', name: 'nightly' }],
    logger: silentLogger,
  })
  const [silence] = s.list()
  assert.ok(silence.id.startsWith('cfg:'))
  assert.equal(s.remove(silence.id), false)
  assert.equal(s.persistable().length, 0, 'config silences are not persisted')
})

test('runtime silences can be added, listed and removed', () => {
  const s = new SilenceManager({ logger: silentLogger })
  const added = s.add({ match: 'api', reason: 'deploy', createdBy: 'harsh' })
  assert.equal(s.list().length, 1)
  assert.equal(added.reason, 'deploy')
  assert.ok(s.remove(added.id))
  assert.equal(s.list().length, 0)
  assert.equal(s.remove('missing'), false)
})

test('expired silences are pruned', () => {
  const s = new SilenceManager({ logger: silentLogger })
  s.add({ match: 'api', until: '2020-01-01T00:00:00Z' })
  s.add({ match: 'keep' })
  assert.equal(s.prune(), 1)
  assert.equal(s.persistable().length, 1)
})

test('invalid silences are rejected with a reason', () => {
  assert.deepEqual(validateSilence({ match: 'a' }), [])
  assert.match(validateSilence({}).join(), /"match" is required/)
  assert.match(validateSilence({ match: 'a', until: 'soon' }).join(), /ISO timestamp/)
  assert.match(validateSilence({ match: 'a', daily: { start: '25:00', end: '02:00' } }).join(), /HH:MM/)
  assert.match(validateSilence({ match: 'a', days: [9] }).join(), /0-6/)
  assert.throws(() => new SilenceManager({ logger: silentLogger }).add({}), /Invalid silence/)
})

test('config rejects a malformed silences block at startup', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { silences: [{ until: 'nope' }] } }),
    /silences\[0\]/
  )
  assert.throws(() => loadConfig({ env: {}, overrides: { silences: 'no' } }), /must be an array/)
})

const webhookReceiver = () =>
  new Promise((resolve) => {
    const received = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push(JSON.parse(body))
        res.writeHead(200, { 'Content-Type': 'application/json' })
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

const buildAgent = async (hookUrl, dir) =>
  new FaultlineAgent(
    loadConfig({
      env: {},
      overrides: {
        source: {
          type: 'synthetic',
          options: { seed: 7, incident: { service: 'checkout-api', startAfterWindows: 10 } },
        },
        detector: { intervalSeconds: 3600, baselineWindows: 8, minSustain: 2, historyWindows: 60 },
        alerting: { cooldownSeconds: 0, resolveAfterWindows: 3, notifiers: [{ type: 'webhook', url: hookUrl }] },
        server: { enabled: false },
        storage: { path: join(dir, 'state.json') },
      },
    }),
    { logger: silentLogger }
  )

test('a silenced service is detected and recorded but never paged', async () => {
  const hook = await webhookReceiver()
  const dir = await mkdtemp(join(tmpdir(), 'faultline-sil-'))
  const agent = await buildAgent(hook.url, dir)

  try {
    await agent.start()
    agent.silences.add({ match: 'checkout-*', reason: 'planned deploy' })
    for (let i = 0; i < 30; i++) await agent.tick()

    assert.equal(hook.received.length, 0, 'no alert should be sent while silenced')
    assert.ok(agent.store.stats().total >= 1, 'the incident is still recorded')
    const incident = agent.store.getIncidents()[0]
    assert.ok(incident.silencedBy, 'the incident records which silence suppressed it')
    assert.equal(incident.notifiedAt, undefined)
  } finally {
    await agent.stop()
    await hook.close()
  }
})

test('an incident still firing when a silence is lifted is announced late', async () => {
  const hook = await webhookReceiver()
  const dir = await mkdtemp(join(tmpdir(), 'faultline-sil2-'))
  const agent = await buildAgent(hook.url, dir)

  try {
    await agent.start()
    const silence = agent.silences.add({ match: 'checkout-api' })

    for (let i = 0; i < 16; i++) await agent.tick()
    assert.equal(hook.received.length, 0, 'silent so far')

    agent.silences.remove(silence.id)
    await agent.tick()

    const opened = hook.received.filter((r) => r.event === 'incident.opened')
    assert.equal(opened.length, 1, 'the ongoing incident should page once un-silenced')
    assert.equal(opened[0].incident.service, 'checkout-api')
  } finally {
    await agent.stop()
    await hook.close()
  }
})

test('silences survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-sil3-'))
  const hook = await webhookReceiver()

  const first = await buildAgent(hook.url, dir)
  await first.start()
  first.silences.add({ match: 'checkout-api', reason: 'long deploy' })
  first.syncSilences()
  await first.stop()

  const second = await buildAgent(hook.url, dir)
  try {
    await second.start()
    assert.equal(second.silences.list().length, 1)
    assert.ok(second.silences.isSilenced('checkout-api'))
  } finally {
    await second.stop()
    await hook.close()
  }
})
