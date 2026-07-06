import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTelemetryCsv, EXAMPLE_CSV } from '../src/lib/parseTelemetry.js'
import { runDetection } from '../src/lib/detectionEngine.js'

const VALID = `window,p99_latency,retry_rate,error_rate
1,100,0.5,0.2
2,102,0.5,0.2
3,98,0.5,0.2
4,101,0.5,0.2
5,150,1.5,0.9`

test('parses canonical headers', () => {
  const { raw, error } = parseTelemetryCsv(VALID)
  assert.equal(error, null)
  assert.equal(raw.length, 5)
  assert.equal(raw[0].p99_latency, 100)
  assert.equal(raw[4].retry_rate, 1.5)
})

test('accepts common header aliases', () => {
  const csv = `w,latency_ms,retries,err_rate
1,100,0.5,0.2
2,102,0.5,0.2
3,98,0.5,0.2
4,101,0.5,0.2
5,150,1.5,0.9`
  const { raw, error } = parseTelemetryCsv(csv)
  assert.equal(error, null)
  assert.equal(raw.length, 5)
})

test('accepts tab-delimited input', () => {
  const csv = VALID.replace(/,/g, '\t')
  const { raw, error } = parseTelemetryCsv(csv)
  assert.equal(error, null)
  assert.equal(raw.length, 5)
})

test('rejects empty input', () => {
  assert.notEqual(parseTelemetryCsv('').error, null)
  assert.notEqual(parseTelemetryCsv('   \n  ').error, null)
})

test('rejects missing required columns with a helpful message', () => {
  const { raw, error } = parseTelemetryCsv('window,p99_latency\n1,100\n2,100\n3,100\n4,100\n5,100')
  assert.equal(raw, null)
  assert.match(error, /retry_rate/)
  assert.match(error, /error_rate/)
})

test('rejects fewer than five valid rows', () => {
  const { raw, error } = parseTelemetryCsv('window,p99_latency,retry_rate,error_rate\n1,100,0.5,0.2\n2,100,0.5,0.2')
  assert.equal(raw, null)
  assert.match(error, /at least 5/)
})

test('skips malformed rows and comment lines', () => {
  const csv = `# telemetry export
window,p99_latency,retry_rate,error_rate
1,100,0.5,0.2
2,not-a-number,0.5,0.2
3,98,0.5,0.2
4,101,0.5,0.2
5,103,0.5,0.2
6,150,1.5,0.9`
  const { raw, error } = parseTelemetryCsv(csv)
  assert.equal(error, null)
  assert.equal(raw.length, 5)
  assert.ok(raw.every((r) => Number.isFinite(r.p99_latency)))
})

test('assigns sequential window numbers when the column is absent', () => {
  const csv = `p99_latency,retry_rate,error_rate
100,0.5,0.2
102,0.5,0.2
98,0.5,0.2
101,0.5,0.2
150,1.5,0.9`
  const { raw, error } = parseTelemetryCsv(csv)
  assert.equal(error, null)
  assert.deepEqual(raw.map((r) => r.window_number), [1, 2, 3, 4, 5])
})

test('the bundled example parses and produces a detectable cascade', () => {
  const { raw, error } = parseTelemetryCsv(EXAMPLE_CSV)
  assert.equal(error, null)
  assert.equal(raw.length, 12)
  const result = runDetection(raw)
  assert.equal(result.detectionWindow.window_number, 8)
  assert.equal(result.outageWindow.window_number, 11)
})
