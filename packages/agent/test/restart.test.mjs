import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

const makeAgent = (dir, { hookUrl = null, storage = {}, incidentAfter = 10, holdWindows = 6 } = {}) =>
  new FaultlineAgent(
    loadConfig({
      env: {},
      overrides: {
        source: {
          type: 'synthetic',
          options: {
            seed: 7,
            incident: { service: 'checkout-api', startAfterWindows: incidentAfter },
            holdWindows,
          },
        },
        detector: { intervalSeconds: 3600, baselineWindows: 8, minSustain: 2, historyWindows: 60 },
        alerting: {
          cooldownSeconds: 0,
          resolveAfterWindows: 3,
          notifiers: hookUrl ? [{ type: 'webhook', url: hookUrl }] : [],
        },
        server: { enabled: false },
        storage: { path: join(dir, 'state.json'), ...storage },
      },
    }),
    { logger: silentLogger }
  )

test('a restart resumes detection instead of warming up again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart-'))

  const first = makeAgent(dir)
  await first.start()
  for (let i = 0; i < 14; i++) await first.tick()
  const before = first.snapshot().services.find((s) => s.service === 'checkout-api')
  assert.equal(before.status, 'evaluated')
  await first.stop()

  const second = makeAgent(dir)
  try {
    await second.start()
    assert.equal(second.stateRestore.restored, true)
    assert.ok(second.stateRestore.samples > 0)

    // One tick after restart must already evaluate: no warm-up gap.
    await second.tick()
    const after = second.snapshot().services.find((s) => s.service === 'checkout-api')
    assert.equal(after.status, 'evaluated', 'detection should resume immediately')
    assert.ok(after.windowsBuffered > 10)
  } finally {
    await second.stop()
  }
})

test('an incident in flight is not paged twice across a restart', async () => {
  const hook = await webhookReceiver()
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart2-'))

  // A long hold keeps the incident firing across the restart, which is the
  // case being tested; a recovered incident would prove nothing.
  const first = makeAgent(dir, { hookUrl: hook.url, holdWindows: 60 })
  await first.start()
  for (let i = 0; i < 22; i++) await first.tick()
  const opened = hook.received.filter((r) => r.event === 'incident.opened')
  assert.equal(opened.length, 1, 'the incident should have paged once before restart')
  assert.equal(first.alerts.stateFor('checkout-api').status, 'firing', 'must still be firing at restart')
  const incidentId = opened[0].incident.id
  await first.stop()

  const second = makeAgent(dir, { hookUrl: hook.url, holdWindows: 60 })
  try {
    await second.start()

    // The open incident is carried across the restart, so the agent knows this
    // has already been alerted on rather than treating it as new.
    const carried = second.alerts.stateFor('checkout-api')
    assert.equal(carried.status, 'firing')
    assert.equal(carried.incident?.id, incidentId)
    assert.ok(carried.incident.notifiedAt, 'the restored incident remembers it was already sent')

    for (let i = 0; i < 4; i++) await second.tick()

    const reopened = hook.received.filter((r) => r.event === 'incident.opened')
    assert.equal(reopened.length, 1, 'a restart must not re-page an incident already alerted on')
  } finally {
    await second.stop()
    await hook.close()
  }
})

test('stale state is discarded rather than trusted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart3-'))

  const first = makeAgent(dir)
  await first.start()
  for (let i = 0; i < 14; i++) await first.tick()
  await first.stop()

  // Backdate the snapshot well beyond the restore window.
  const path = join(dir, 'state.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  saved.detectionState.savedAt = new Date(Date.now() - 3600 * 1000).toISOString()
  await writeFile(path, JSON.stringify(saved))

  const second = makeAgent(dir, { storage: { restoreMaxAgeSeconds: 900 } })
  try {
    await second.start()
    assert.equal(second.stateRestore.restored, false)
    assert.equal(second.stateRestore.reason, 'stale')
    await second.tick()
    const after = second.snapshot().services.find((s) => s.service === 'checkout-api')
    assert.equal(after.status, 'warming_up', 'stale telemetry must not seed a baseline')
  } finally {
    await second.stop()
  }
})

test('restore can be disabled outright', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart4-'))
  const first = makeAgent(dir)
  await first.start()
  for (let i = 0; i < 14; i++) await first.tick()
  await first.stop()

  const second = makeAgent(dir, { storage: { restoreMaxAgeSeconds: 0 } })
  try {
    await second.start()
    assert.equal(second.stateRestore.restored, false)
    assert.equal(second.stateRestore.reason, 'disabled')
  } finally {
    await second.stop()
  }
})

test('a first run with no saved state warms up normally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart5-'))
  const agent = makeAgent(dir)
  try {
    await agent.start()
    assert.equal(agent.stateRestore.restored, false)
    assert.equal(agent.stateRestore.reason, 'no_saved_state')
  } finally {
    await agent.stop()
  }
})

test('corrupt saved state does not prevent startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart6-'))
  await writeFile(
    join(dir, 'state.json'),
    JSON.stringify({ version: 3, detectionState: { savedAt: 'not-a-date', buffers: 'nonsense', alerts: null } })
  )

  const agent = makeAgent(dir)
  try {
    await agent.start()
    assert.equal(agent.stateRestore.restored, false)
    assert.equal(agent.stateRestore.reason, 'unreadable_timestamp')
    await agent.tick()
    assert.equal(agent.snapshot().running, true)
  } finally {
    await agent.stop()
  }
})

test('detection state is snapshotted periodically, not only on shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart7-'))
  const agent = makeAgent(dir, { storage: { snapshotEveryTicks: 5 } })
  try {
    await agent.start()
    for (let i = 0; i < 6; i++) await agent.tick()
    await agent.store.flush()

    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.ok(saved.detectionState?.savedAt, 'a mid-run snapshot should exist without a clean stop')
    assert.ok(saved.detectionState.buffers.length > 0)
  } finally {
    await agent.stop()
  }
})

test('restored buffers respect the history limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-restart8-'))
  const first = makeAgent(dir)
  await first.start()
  for (let i = 0; i < 30; i++) await first.tick()
  await first.stop()

  const second = makeAgent(dir)
  try {
    await second.start()
    assert.ok(second.detector.buffer.size('checkout-api') <= 60)
    assert.ok(second.detector.buffer.size('checkout-api') > 0)
  } finally {
    await second.stop()
  }
})
