import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FaultlineAgent } from '../src/agent.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'

const makeAgent = async (overrides = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'faultline-rank-'))
  return new FaultlineAgent(
    loadConfig({
      env: {},
      overrides: {
        source: {
          type: 'synthetic',
          options: {
            seed: 7,
            incident: { service: 'checkout-api', startAfterWindows: 10 },
            holdWindows: 60,
          },
        },
        detector: { intervalSeconds: 3600, baselineWindows: 8, minSustain: 2, historyWindows: 60 },
        alerting: { cooldownSeconds: 0, resolveAfterWindows: 3, notifiers: [] },
        server: { enabled: false },
        storage: { path: join(dir, 'state.json') },
        ...overrides,
      },
    }),
    { logger: silentLogger }
  )
}

test('ranks the drifting service above its healthy peers', async () => {
  const agent = await makeAgent()
  try {
    await agent.start()
    for (let i = 0; i < 22; i++) await agent.tick()

    const ranking = agent.ranking()
    assert.equal(ranking.services[0].service, 'checkout-api', 'the degrading service should rank first')
    assert.equal(ranking.services[0].rank, 1)
    assert.equal(ranking.evaluated, 3)
    assert.equal(ranking.warmingUp, 0)

    const scores = ranking.services.map((s) => s.R_score)
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i - 1] >= scores[i], 'scores must be in descending order')
    }
  } finally {
    await agent.stop()
  }
})

test('a service still warming up is ranked last with a null score, not a low one', async () => {
  const agent = await makeAgent()
  try {
    await agent.start()
    // Only a few ticks: nothing has a baseline yet.
    for (let i = 0; i < 3; i++) await agent.tick()

    const ranking = agent.ranking()
    assert.equal(ranking.evaluated, 0)
    assert.ok(ranking.warmingUp > 0)
    for (const row of ranking.services) {
      assert.equal(row.status, 'warming_up')
      assert.equal(row.R_score, null, 'unknown risk must not be reported as zero risk')
      assert.equal(row.signal_count, null)
    }
  } finally {
    await agent.stop()
  }
})

test('evaluated services always outrank warming-up ones', async () => {
  const agent = await makeAgent()
  try {
    // ranking() is a pure transform over snapshot(), so the ordering rule is
    // exercised directly. Driving a late-joining service through the tick loop
    // would test the synthetic source, not the rule under test.
    agent.snapshot = () => ({
      services: [
        { service: 'fresh', status: 'warming_up', firing: false },
        { service: 'calm', status: 'evaluated', R_score: 0.4, signal_count: 0, firing: false },
        { service: 'hot', status: 'evaluated', R_score: 6.2, signal_count: 3, firing: true },
      ],
    })

    const ranking = agent.ranking()
    assert.deepEqual(
      ranking.services.map((s) => s.service),
      ['hot', 'calm', 'fresh'],
      'highest risk first, unknown risk last'
    )
    assert.equal(ranking.evaluated, 2)
    assert.equal(ranking.warmingUp, 1)
    assert.equal(ranking.services.at(-1).R_score, null)
  } finally {
    await agent.stop()
  }
})

test('ranking reports the trigger threshold so a score can be read in context', async () => {
  const agent = await makeAgent()
  try {
    await agent.start()
    for (let i = 0; i < 12; i++) await agent.tick()
    const ranking = agent.ranking()
    assert.equal(ranking.triggerThreshold, 3)
    assert.ok(ranking.generatedAt)
  } finally {
    await agent.stop()
  }
})

test('limit caps the list without reordering it', async () => {
  const agent = await makeAgent()
  try {
    await agent.start()
    for (let i = 0; i < 22; i++) await agent.tick()

    const full = agent.ranking()
    const capped = agent.ranking({ limit: 2 })
    assert.equal(capped.services.length, 2)
    assert.deepEqual(
      capped.services.map((s) => s.service),
      full.services.slice(0, 2).map((s) => s.service)
    )
  } finally {
    await agent.stop()
  }
})

test('a silenced service still appears in the ranking', async () => {
  const agent = await makeAgent()
  try {
    await agent.start()
    agent.silences.add({ match: 'checkout-api', reason: 'deploy' })
    for (let i = 0; i < 22; i++) await agent.tick()

    const top = agent.ranking().services[0]
    assert.equal(top.service, 'checkout-api')
    assert.equal(top.silenced, true, 'silencing suppresses paging, not visibility')
  } finally {
    await agent.stop()
  }
})
