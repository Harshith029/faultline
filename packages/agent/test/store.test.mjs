import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { silentLogger } from '../src/logger.js'

// A file where the state directory should be makes every write fail until it
// is removed — a portable stand-in for a full disk or a read-only volume.
const blockedStore = async (options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-store-'))
  const blocker = join(dir, 'state')
  await writeFile(blocker, 'not a directory')
  const store = new Store({ path: join(blocker, 'state.json'), logger: silentLogger, ...options })
  return { store, blocker, statePath: join(blocker, 'state.json') }
}

const until = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

const readState = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

test('a failed write leaves the store dirty, and the next flush saves the change', async () => {
  const { store, blocker, statePath } = await blockedStore({ flushIntervalMs: 60_000 })

  store.upsertIncident({ id: 'inc_1', service: 'api', status: 'firing' })
  await assert.rejects(store.flush())
  assert.equal(store.dirty, true, 'the change was not saved, so it must still be marked unsaved')

  await rm(blocker)
  assert.equal(await store.flush(), true)
  assert.equal(store.dirty, false)
  assert.equal((await readState(statePath)).incidents[0].id, 'inc_1')

  await store.close()
})

test('a scheduled flush that fails retries by itself, without waiting for another change', async () => {
  const { store, blocker, statePath } = await blockedStore({ flushIntervalMs: 10 })

  store.upsertIncident({ id: 'inc_1', service: 'api', status: 'firing' })
  // Let the first scheduled write fail, then clear the fault. No further
  // mutation happens: an idle agent must still get its state onto disk.
  assert.ok(await until(async () => store.dirty && store.retryDelayMs > 10), 'the failed flush was not rescheduled')
  await rm(blocker)

  assert.ok(await until(async () => (await readState(statePath))?.incidents?.[0]?.id === 'inc_1'), 'never retried')
  assert.equal(store.dirty, false)

  await store.close()
})

test('while writes are failing, a new change waits for the backoff instead of retrying at once', async () => {
  const { store, blocker } = await blockedStore({ flushIntervalMs: 200 })

  store.upsertIncident({ id: 'inc_1', service: 'api', status: 'firing' })
  assert.ok(await until(async () => store.failing && store.timer !== null), 'the first write never failed')
  const backoff = store.timer

  // A tick keeps changing state while the disk is full.
  store.upsertIncident({ id: 'inc_2', service: 'api', status: 'firing' })
  assert.equal(store.timer, backoff, 'the change replaced the backoff timer with a short one')

  await rm(blocker)
  await store.close()
})

test('stats count retired incidents separately from resolved ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-store-'))
  const store = new Store({ path: join(dir, 'state.json'), logger: silentLogger, flushIntervalMs: 60_000 })
  store.upsertIncident({ id: 'a', service: 'api', status: 'firing' })
  store.upsertIncident({ id: 'b', service: 'api', status: 'resolved' })
  store.upsertIncident({ id: 'c', service: 'old', status: 'retired' })

  assert.deepEqual(store.stats(), { total: 3, firing: 1, resolved: 1, retired: 1 })
  await store.close()
})

test('overlapping flushes are serialised, and the newest state is what lands on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-store-'))
  const statePath = join(dir, 'state.json')
  const store = new Store({ path: statePath, logger: silentLogger, flushIntervalMs: 60_000 })

  store.upsertIncident({ id: 'inc_1', service: 'api', status: 'firing' })
  const first = store.flush()
  store.upsertIncident({ id: 'inc_2', service: 'worker', status: 'firing' })
  const second = store.flush()

  // Both writes share one temp file. Run at once they race each other's rename.
  await Promise.all([first, second])

  const saved = await readState(statePath)
  assert.deepEqual(saved.incidents.map((i) => i.id).sort(), ['inc_1', 'inc_2'])
  assert.equal(store.dirty, false)

  await store.close()
})
