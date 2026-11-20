import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTelemetryCsv, EXAMPLE_CSV } from '../parseTelemetry.js'
import { runDetection } from '../detectionEngine.js'

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

test('a skipped row is reported with its line and the reason', () => {
  const csv = `# telemetry export
window,p99_latency,retry_rate,error_rate
1,100,0.5,0.2
2,not-a-number,0.5,0.2
3,98,0.5,0.2
4,,0.5,0.2
5,103,0.5,0.2
6,150,1.5,0.9
7,151,1.6,1.0`
  const { raw, skipped } = parseTelemetryCsv(csv)
  assert.equal(raw.length, 5)
  assert.deepEqual(skipped, [
    { line: 4, reason: 'p99_latency is "not-a-number", which is not a number' },
    { line: 6, reason: 'p99_latency is empty' },
  ])
})

test('a value with trailing junk is rejected, not read as its numeric prefix', () => {
  // parseFloat("12x") is 12. A typo must not become a measurement.
  const csv = `window,p99_latency,retry_rate,error_rate
1,100,0.5,0.2
2,12x,0.5,0.2
3,98,0.5,0.2
4,101,0.5,0.2
5,103,0.5,0.2
6,150,1.5,0.9`
  const { raw, skipped } = parseTelemetryCsv(csv)
  assert.ok(raw.every((r) => r.window_number !== 2))
  assert.deepEqual(skipped, [{ line: 3, reason: 'p99_latency is "12x", which is not a number' }])
})

test('a quoted field may contain the delimiter, quotes and line breaks without shifting columns', () => {
  const csv = `window,note,p99_latency,retry_rate,error_rate
1,"deploy, then rollback",100,0.5,0.2
2,steady,102,0.5,0.2
3,"said ""ok""",98,0.5,0.2
4,,101,0.5,0.2
5,"two
lines",150,1.5,0.9`
  const { raw, error } = parseTelemetryCsv(csv)
  assert.equal(error, null)
  assert.deepEqual(
    raw.map((r) => r.p99_latency),
    [100, 102, 98, 101, 150]
  )
})

test('Windows line endings parse identically', () => {
  const { raw, error } = parseTelemetryCsv(VALID.replace(/\n/g, '\r\n'))
  assert.equal(error, null)
  assert.equal(raw.length, 5)
  assert.equal(raw[4].error_rate, 0.9)
})

test('an unterminated quote is reported instead of swallowing the rest of the file', () => {
  const { raw, error } = parseTelemetryCsv('window,p99_latency,retry_rate,error_rate\n1,"100,0.5,0.2\n2,100,0.5,0.2')
  assert.equal(raw, null)
  assert.match(error, /line 2/)
  assert.match(error, /quote/)
})

test('a skipped row leaves a hole in positional window numbers instead of closing it up', () => {
  // Renumbering the surviving rows 1..n would make rows either side of the bad
  // one look adjacent, so a sustained run could span the missing window.
  const csv = `p99_latency,retry_rate,error_rate
100,0.5,0.2
102,0.5,0.2
oops,0.5,0.2
101,0.5,0.2
103,0.5,0.2
150,1.5,0.9`
  const { raw } = parseTelemetryCsv(csv)
  assert.deepEqual(
    raw.map((r) => r.window_number),
    [1, 2, 4, 5, 6]
  )
})

test('window numbers must strictly increase', () => {
  const csv = `window,p99_latency,retry_rate,error_rate
1,100,0.5,0.2
2,102,0.5,0.2
2,98,0.5,0.2
4,101,0.5,0.2
5,150,1.5,0.9`
  const { raw, error } = parseTelemetryCsv(csv)
  assert.equal(raw, null)
  assert.match(error, /line 4: window 2 does not come after window 2/)
})

test('a window number that is not a whole number skips the row', () => {
  const csv = `window,p99_latency,retry_rate,error_rate
1,100,0.5,0.2
2.5,102,0.5,0.2
3,98,0.5,0.2
4,101,0.5,0.2
5,103,0.5,0.2
6,150,1.5,0.9`
  const { raw, skipped } = parseTelemetryCsv(csv)
  assert.equal(raw.length, 5)
  assert.deepEqual(skipped, [{ line: 3, reason: 'window is "2.5", which is not a whole number' }])
})

test('a value too large to be a measurement is skipped, not scored as Infinity', () => {
  const csv = `window,p99_latency,retry_rate,error_rate
1,100,0.5,0.2
2,1e999,0.5,0.2
3,98,0.5,0.2
4,101,0.5,0.2
5,103,0.5,0.2
6,150,1.5,0.9`
  const { raw, skipped } = parseTelemetryCsv(csv)
  assert.ok(raw.every((r) => Number.isFinite(r.p99_latency)))
  assert.deepEqual(skipped, [{ line: 3, reason: 'p99_latency is "1e999", which is too large to be a measurement' }])
})

test('a cell echoed in a skip reason is shortened', () => {
  const junk = 'x'.repeat(500)
  const csv = `window,p99_latency,retry_rate,error_rate
1,${junk},0.5,0.2
2,100,0.5,0.2
3,98,0.5,0.2
4,101,0.5,0.2
5,103,0.5,0.2
6,150,1.5,0.9`
  const [{ reason }] = parseTelemetryCsv(csv).skipped
  assert.ok(reason.length < 100, `reason is ${reason.length} characters`)
  assert.match(reason, /x…"/)
})

test('input beyond the size limit is refused before parsing', () => {
  const { raw, error } = parseTelemetryCsv('p99_latency\n' + '1\n'.repeat(2_600_000))
  assert.equal(raw, null)
  assert.match(error, /5 MB/)
})

test('a quote inside an unquoted cell is literal, and quote-heavy input parses in linear time', () => {
  const csv = `window,note,p99_latency,retry_rate,error_rate
1,6" pipe,100,0.5,0.2
2,a,102,0.5,0.2
3,a,98,0.5,0.2
4,a,101,0.5,0.2
5,a,150,1.5,0.9`
  assert.equal(parseTelemetryCsv(csv).raw.length, 5)

  // Every quote used to re-trim the whole cell built so far: quadratic, enough
  // to freeze a browser tab on one pathological line.
  const started = Date.now()
  const { skipped } = parseTelemetryCsv(`window,p99_latency,retry_rate,error_rate\n1,${'a"'.repeat(60_000)},1,1\n`)
  assert.equal(skipped.length, 1)
  assert.ok(Date.now() - started < 2000, 'parsing a quote-heavy cell took too long')
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
