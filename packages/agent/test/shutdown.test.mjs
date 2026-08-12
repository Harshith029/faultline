import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const sample = (over = {}) => ({
  service: 'api',
  p99_latency: 120,
  retry_rate: 1,
  error_rate: 0.4,
  ...over,
})

const makeAgent = async ({ collect, notifiers = [], storageOverrides = {} } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-shutdown-'))
  const statePath = join(dir, 'state.json')
  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'synthetic', options: {} },
      detector: { intervalSeconds: 3600, baselineWindows: 4, minSustain: 2, historyWindows: 20 },
      alerting: { cooldownSeconds: 0, resolveAfterWindows: 2, notifiers },
      server: { enabled: false },
      storage: { path: statePath, snapshotEveryTicks: 1000, ...storageOverrides },
    },
  })
  const agent = new FaultlineAgent(config, { logger: silentLogger, env: {} })
  if (collect) agent.source = { name: 'stub', collect, state: () => ({}) }
  return { agent, statePath, dir }
}

// --- shutdown during collection ---------------------------------------------

test('stop() waits for an in-flight collection instead of racing it', async () => {
  const gate = deferred()
  const entered = deferred()
  let collectsFinished = 0

  const { agent } = await makeAgent({
    collect: async () => {
      entered.resolve()
      await gate.promise
      collectsFinished += 1
      return [sample()]
    },
  })

  const startPromise = agent.start()
  // start() awaits store load before its first tick, so wait for collection to
  // actually be in flight rather than assuming it began synchronously.
  await entered.promise

  const stopPromise = agent.stop({ graceMs: 2000 })

  // stop() must not have completed while collection is still outstanding.
  const raced = await Promise.race([
    stopPromise.then(() => 'stopped'),
    new Promise((r) => setTimeout(() => r('still-waiting'), 50)),
  ])
  assert.equal(raced, 'still-waiting', 'stop() returned before the tick finished')

  gate.resolve()
  await startPromise
  await stopPromise

  assert.equal(collectsFinished, 1)
})

test('a tick that finishes during shutdown has its work persisted, not discarded', async () => {
  const gate = deferred()
  const entered = deferred()
  const { agent, statePath } = await makeAgent({
    collect: async () => {
      entered.resolve()
      await gate.promise
      return [sample()]
    },
  })

  const startPromise = agent.start()
  await entered.promise
  const stopPromise = agent.stop({ graceMs: 2000 })

  gate.resolve()
  await startPromise
  await stopPromise

  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const buffered = state.detectionState.buffers.find((b) => b.service === 'api')
  assert.ok(buffered, 'the sample collected during shutdown must be in the saved state')
  assert.equal(buffered.samples.length, 1)
})

test('a wedged collection is abandoned after the grace period rather than hanging', async () => {
  const never = new Promise(() => {})
  const entered = deferred()
  const { agent, statePath } = await makeAgent({
    collect: () => {
      entered.resolve()
      return never
    },
  })

  agent.start()
  await entered.promise
  const startedAt = Date.now()
  await agent.stop({ graceMs: 120 })
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed >= 100, `stop returned too early (${elapsed}ms)`)
  assert.ok(elapsed < 2000, `stop hung past its grace period (${elapsed}ms)`)

  // It still closed cleanly. The store is written (it holds silences), but no
  // detection state was snapshotted because no tick ever completed — an
  // abandoned collection must not fabricate progress.
  assert.equal(agent.ticks, 0)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.detectionState ?? null, null)
})

// --- no work after shutdown -------------------------------------------------

test('a tick scheduled before shutdown does nothing if it fires after it', async () => {
  let collects = 0
  const { agent } = await makeAgent({
    collect: async () => {
      collects += 1
      return [sample()]
    },
  })

  await agent.start()
  assert.equal(collects, 1)

  await agent.stop()

  // Simulate the interval callback firing after stop() completed.
  await agent.tick()

  assert.equal(collects, 1, 'no collection may run after shutdown')
  assert.equal(agent.ticks, 1)
})

test('the interval timer is cleared so no further ticks are scheduled', async () => {
  const { agent } = await makeAgent({ collect: async () => [sample()] })
  await agent.start()
  assert.ok(agent.timer !== null)

  await agent.stop()
  assert.equal(agent.timer, null)
  assert.equal(agent.running, false)
})

test('stop() is idempotent and saves exactly once', async () => {
  let snapshots = 0
  const { agent } = await makeAgent({ collect: async () => [sample()] })
  await agent.start()

  const original = agent.snapshotDetectionState.bind(agent)
  agent.snapshotDetectionState = () => {
    snapshots += 1
    return original()
  }

  await Promise.all([agent.stop(), agent.stop(), agent.stop()])

  assert.equal(snapshots, 1, 'concurrent stops must not each write state')
})

// --- shutdown during notification -------------------------------------------

test('stop() waits for an in-flight notification to finish', async () => {
  const gate = deferred()
  const delivered = []

  // A source that produces an incident on the tick we control.
  let window = 0
  const { agent } = await makeAgent({
    collect: async () => {
      window += 1
      const spike = window > 6
      return [
        sample({
          p99_latency: spike ? 900 : 120,
          retry_rate: spike ? 14 : 1,
          error_rate: spike ? 11 : 0.4,
        }),
      ]
    },
    notifiers: [],
  })

  agent.notifiers = {
    types: ['stub'],
    notify: async (payload) => {
      await gate.promise
      delivered.push(payload.type)
    },
  }

  await agent.start()
  for (let i = 0; i < 6; i++) await agent.tick()

  // The next tick opens an incident and blocks inside the notifier.
  const blockedTick = agent.tick()
  const stopPromise = agent.stop({ graceMs: 2000 })

  const raced = await Promise.race([
    stopPromise.then(() => 'stopped'),
    new Promise((r) => setTimeout(() => r('still-waiting'), 50)),
  ])
  assert.equal(raced, 'still-waiting', 'stop() must not complete mid-notification')

  gate.resolve()
  await blockedTick
  await stopPromise

  assert.deepEqual(delivered, ['incident.opened'])
})

test('an incident opened just before shutdown survives into the saved state', async () => {
  let window = 0
  const { agent, statePath } = await makeAgent({
    collect: async () => {
      window += 1
      const spike = window > 6
      return [
        sample({
          p99_latency: spike ? 900 : 120,
          retry_rate: spike ? 14 : 1,
          error_rate: spike ? 11 : 0.4,
        }),
      ]
    },
  })

  await agent.start()
  for (let i = 0; i < 8; i++) await agent.tick()
  await agent.stop()

  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.ok(state.detectionState.alerts.length > 0, 'alert lifecycle must be persisted')
  assert.ok(state.incidents.length > 0, 'the incident itself must be persisted')
})

// --- restart ----------------------------------------------------------------

test('state saved at shutdown is restored on the next start', async () => {
  const { agent, statePath, dir } = await makeAgent({ collect: async () => [sample()] })
  await agent.start()
  for (let i = 0; i < 5; i++) await agent.tick()
  const bufferedBefore = agent.detector.buffer.size('api')
  await agent.stop()

  const config = loadConfig({
    env: {},
    overrides: {
      source: { type: 'synthetic', options: {} },
      detector: { intervalSeconds: 3600, baselineWindows: 4, minSustain: 2, historyWindows: 20 },
      alerting: { notifiers: [] },
      server: { enabled: false },
      storage: { path: statePath },
    },
  })
  const revived = new FaultlineAgent(config, { logger: silentLogger, env: {} })
  revived.source = { name: 'stub', collect: async () => [sample()], state: () => ({}) }
  await revived.start()

  assert.equal(revived.stateRestore.restored, true)
  assert.equal(revived.detector.buffer.size('api'), bufferedBefore + 1)

  await revived.stop()
  assert.ok(dir)
})

test('a never-started agent can still run a single tick (the `once` command)', async () => {
  // Regression: guarding tick() on `running` as well as `stopping` silently
  // turned `faultline once` into a no-op, because `once` ticks an agent it
  // never starts.
  const { agent } = await makeAgent({ collect: async () => [sample()] })

  await agent.store.load()
  await agent.tick()

  assert.equal(agent.ticks, 1)
  assert.equal(agent.snapshot().services.length, 1)

  await agent.stop()
})
