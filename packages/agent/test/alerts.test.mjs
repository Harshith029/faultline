import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AlertManager } from '../src/alerts.js'

const evaluation = (triggered, R = 4, signals = 2) => ({
  triggered,
  R_score: R,
  signal_count: signals,
  qualified_signals: [{ metric: 'p99_latency_z', z_score: 3.1, windows_sustained: 2 }],
  metrics: { p99_latency_z: 3.1, retry_rate_z: 2.2, error_rate_z: 1.1 },
})

test('opens an incident on the first triggered window', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 2 })
  const result = alerts.evaluate({ service: 'api', evaluation: evaluation(true, 3.5), nowMs: 1000 })
  assert.equal(result.type, 'opened')
  assert.equal(result.incident.service, 'api')
  assert.equal(result.incident.status, 'firing')
  assert.equal(result.incident.triggerR, 3.5)
})

test('a sustained cascade produces one incident, not one per window', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 2 })
  const opened = alerts.evaluate({ service: 'api', evaluation: evaluation(true, 3.2), nowMs: 1000 })
  const results = [2000, 3000, 4000].map((nowMs) =>
    alerts.evaluate({ service: 'api', evaluation: evaluation(true, 6.4), nowMs })
  )
  assert.deepEqual(results.map((r) => r.type), ['updated', 'updated', 'updated'])
  assert.equal(results.at(-1).incident.id, opened.incident.id)
  assert.equal(results.at(-1).incident.peakR, 6.4)
  assert.equal(results.at(-1).incident.windowsFiring, 4)
})

test('a single clean window does not resolve an incident', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 3 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 1000 })
  const result = alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 2000 })
  assert.equal(result.type, 'recovering')
  assert.equal(result.clearStreak, 1)
})

test('resolves only after the configured run of clean windows', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 3 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 1000 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 2000 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 3000 })
  const resolved = alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 4000 })
  assert.equal(resolved.type, 'resolved')
  assert.equal(resolved.incident.status, 'resolved')
  assert.equal(resolved.incident.durationMs, 3000)
})

test('a clean window mid-incident resets the recovery streak', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 3 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 1000 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 2000 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 3000 })
  const after = alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 4000 })
  assert.equal(after.type, 'recovering')
  assert.equal(after.clearStreak, 1)
})

test('cooldown suppresses immediate re-opening after resolution', () => {
  const alerts = new AlertManager({ cooldownSeconds: 60, resolveAfterWindows: 1 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 1000 })
  alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 2000 })

  const suppressed = alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 5000 })
  assert.equal(suppressed.type, 'suppressed')
  assert.equal(suppressed.reason, 'cooldown')

  const reopened = alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 70000 })
  assert.equal(reopened.type, 'opened')
})

test('services have independent incident state', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 2 })
  alerts.evaluate({ service: 'a', evaluation: evaluation(true), nowMs: 1000 })
  const b = alerts.evaluate({ service: 'b', evaluation: evaluation(false), nowMs: 1000 })
  assert.equal(b.type, 'none')
  assert.equal(alerts.stateFor('a').status, 'firing')
  assert.equal(alerts.stateFor('b').status, 'ok')
})

test('clean windows on a healthy service do nothing', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 2 })
  assert.equal(alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 1 }).type, 'none')
})

test('incident ids are unique per incident', () => {
  const alerts = new AlertManager({ cooldownSeconds: 0, resolveAfterWindows: 1 })
  const first = alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 1000 }).incident.id
  alerts.evaluate({ service: 'api', evaluation: evaluation(false), nowMs: 2000 })
  const second = alerts.evaluate({ service: 'api', evaluation: evaluation(true), nowMs: 3000 }).incident.id
  assert.notEqual(first, second)
})
