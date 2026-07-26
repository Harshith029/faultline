import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, validateConfig, detectorParams, DEFAULT_CONFIG } from '../src/config.js'

const tmpFile = (contents) => {
  const dir = mkdtempSync(join(tmpdir(), 'faultline-cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, contents)
  return path
}

test('loads defaults when no file is given', () => {
  const config = loadConfig({ env: {} })
  assert.equal(config.source.type, 'synthetic')
  assert.equal(config.detector.triggerThreshold, 3.0)
  assert.equal(config.server.port, 8787)
})

test('deep-merges a config file over defaults', () => {
  const path = tmpFile(JSON.stringify({ detector: { triggerThreshold: 5 }, agent: { name: 'custom' } }))
  const config = loadConfig({ path, env: {} })
  assert.equal(config.detector.triggerThreshold, 5)
  assert.equal(config.detector.zThreshold, DEFAULT_CONFIG.detector.zThreshold)
  assert.equal(config.agent.name, 'custom')
})

test('rejects an unknown source type', () => {
  assert.throws(() => loadConfig({ env: {}, overrides: { source: { type: 'carrier-pigeon' } } }), /source.type must be one of/)
})

test('rejects a history window too small for the baseline', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { detector: { historyWindows: 6, baselineWindows: 5, minSustain: 2 } } }),
    /historyWindows \(6\) must be >= baselineWindows \+ minSustain/
  )
})

test('rejects non-integer and out-of-range numbers', () => {
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), server: { port: 70000 } }), /server.port/)
  assert.throws(
    () => loadConfig({ env: {}, overrides: { detector: { minSustain: 1.5 } } }),
    /detector.minSustain must be an integer/
  )
})

test('rejects a webhook notifier with no url or urlEnv', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { alerting: { notifiers: [{ type: 'webhook' }] } } }),
    /requires "url" or "urlEnv"/
  )
})

test('reports every validation problem at once', () => {
  try {
    loadConfig({ env: {}, overrides: { source: { type: 'nope' }, detector: { minSustain: 0 } } })
    assert.fail('should have thrown')
  } catch (err) {
    assert.match(err.message, /source.type/)
    assert.match(err.message, /detector.minSustain/)
  }
})

test('environment variables override file config', () => {
  const path = tmpFile(JSON.stringify({ server: { port: 1234 }, logging: { level: 'info' } }))
  const config = loadConfig({
    path,
    env: { FAULTLINE_PORT: '9999', FAULTLINE_LOG_LEVEL: 'debug', FAULTLINE_INTERVAL_SECONDS: '15' },
  })
  assert.equal(config.server.port, 9999)
  assert.equal(config.logging.level, 'debug')
  assert.equal(config.detector.intervalSeconds, 15)
})

test('a webhook URL from the environment is injected as a notifier', () => {
  const config = loadConfig({ env: { FAULTLINE_WEBHOOK_URL: 'https://example.test/hook' } })
  const webhook = config.alerting.notifiers.find((n) => n.type === 'webhook')
  assert.equal(webhook.url, 'https://example.test/hook')
})

test('detectorParams disables the scenario-only outage threshold', () => {
  const params = detectorParams(loadConfig({ env: {} }))
  assert.equal(params.outageThreshold, Number.POSITIVE_INFINITY)
  assert.equal(params.triggerThreshold, 3.0)
})

test('a malformed config file fails with a clear message', () => {
  const path = tmpFile('{ not json')
  assert.throws(() => loadConfig({ path, env: {} }), /is not valid JSON/)
})
