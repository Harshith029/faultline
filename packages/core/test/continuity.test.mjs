import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PARAMS, runDetection, adjacencyBreaks } from '../detectionEngine.js'

// "Sustained for minSustain windows" is a claim about consecutive moments in
// time. These tests pin down that a sustained run can never be assembled from
// windows either side of a hole in the telemetry.

const PARAMS = { ...DEFAULT_PARAMS, baselineWindows: 4, minSustain: 2, minSignals: 2 }

const CALM = { p99_latency: 100, retry_rate: 1, error_rate: 0.5 }
const HOT = { p99_latency: 300, retry_rate: 5, error_rate: 3 }

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
const minute = (m) => new Date(T0 + m * 60_000).toISOString()

/** Builds windows from [values, window_number, minute] triples. */
const windowsOf = (rows) =>
  rows.map(([values, n, m]) => ({
    window_number: n,
    ...(m === undefined ? {} : { window_timestamp: minute(m) }),
    ...values,
  }))

const last = (result) => result.windows[result.windows.length - 1]

test('two adjacent elevated windows still form a sustained run', () => {
  const result = runDetection(
    windowsOf([[CALM, 1], [CALM, 2], [CALM, 3], [CALM, 4], [HOT, 5], [HOT, 6]]),
    PARAMS
  )
  assert.equal(last(result).triggered, true)
  assert.ok(result.windows.every((w) => !('gap_before' in w)), 'contiguous windows carry no gap marker')
})

test('a missing window number breaks a sustained run', () => {
  // Window 6 never arrived. Windows 5 and 7 are two slots apart, so being
  // elevated in both is not "elevated for two consecutive windows".
  const result = runDetection(
    windowsOf([[CALM, 1], [CALM, 2], [CALM, 3], [CALM, 4], [HOT, 5], [HOT, 7]]),
    PARAMS
  )

  const w7 = last(result)
  assert.equal(w7.triggered, false)
  assert.equal(w7.signal_count, 0)
  assert.equal(w7.gap_before, true)
})

test('a run that restarts after a gap qualifies once it is genuinely sustained', () => {
  const result = runDetection(
    windowsOf([[CALM, 1], [CALM, 2], [CALM, 3], [CALM, 4], [HOT, 5], [HOT, 7], [HOT, 8]]),
    PARAMS
  )
  const w7 = result.windows.find((w) => w.window_number === 7)
  const w8 = result.windows.find((w) => w.window_number === 8)
  assert.equal(w7.triggered, false)
  assert.equal(w8.triggered, true)
  assert.ok(w8.qualified_signals.every((s) => s.windows_sustained === 2))
})

test('repeated or backwards window numbers are not adjacent either', () => {
  const repeated = runDetection(
    windowsOf([[CALM, 1], [CALM, 2], [CALM, 3], [CALM, 4], [HOT, 5], [HOT, 5]]),
    PARAMS
  )
  assert.equal(last(repeated).triggered, false)

  const backwards = runDetection(
    windowsOf([[CALM, 1], [CALM, 2], [CALM, 3], [CALM, 4], [HOT, 6], [HOT, 5]]),
    PARAMS
  )
  assert.equal(last(backwards).triggered, false)
})

test('with a known sampling interval, a hole in the timestamps breaks a run', () => {
  // Consecutive positions, but five minutes of telemetry are missing between
  // the last two windows: what a source that renumbers its rows looks like.
  const rows = windowsOf([
    [CALM, 1, 0],
    [CALM, 2, 1],
    [CALM, 3, 2],
    [CALM, 4, 3],
    [HOT, 5, 4],
    [HOT, 6, 9],
  ])

  const timed = runDetection(rows, { ...PARAMS, windowSeconds: 60 })
  assert.equal(last(timed).triggered, false)
  assert.equal(last(timed).gap_before, true)

  // Without a declared interval the engine cannot know the spacing is wrong,
  // so it falls back to window numbers alone — the pre-existing behaviour.
  const untimed = runDetection(rows, PARAMS)
  assert.equal(last(untimed).triggered, true)
})

test('timestamps within the gap tolerance count as adjacent', () => {
  // 80 seconds apart on a 60-second interval is collection jitter, not a hole.
  const rows = windowsOf([[CALM, 1, 0], [CALM, 2, 1], [CALM, 3, 2], [CALM, 4, 3], [HOT, 5, 4], [HOT, 6, 4]])
  rows[5].window_timestamp = new Date(T0 + 4 * 60_000 + 80_000).toISOString()

  assert.equal(last(runDetection(rows, { ...PARAMS, windowSeconds: 60 })).triggered, true)
})

test('maxGapSeconds widens the tolerance explicitly', () => {
  const rows = windowsOf([[CALM, 1, 0], [CALM, 2, 1], [CALM, 3, 2], [CALM, 4, 3], [HOT, 5, 4], [HOT, 6, 9]])

  const strict = runDetection(rows, { ...PARAMS, windowSeconds: 60 })
  const tolerant = runDetection(rows, { ...PARAMS, windowSeconds: 60, maxGapSeconds: 600 })

  assert.equal(last(strict).triggered, false)
  assert.equal(last(tolerant).triggered, true)
})

test('adjacencyBreaks marks exactly the windows that follow a hole', () => {
  const rows = windowsOf([[CALM, 1, 0], [CALM, 2, 1], [CALM, 4, 3], [CALM, 5, 4], [CALM, 6, 10]])
  assert.deepEqual(adjacencyBreaks(rows, { ...PARAMS, windowSeconds: 60 }), [false, false, true, false, true])
  assert.deepEqual(adjacencyBreaks(rows, PARAMS), [false, false, true, false, false])
})

test('windows without numbers or timestamps keep the original positional behaviour', () => {
  const rows = [CALM, CALM, CALM, CALM, HOT, HOT].map((values) => ({ ...values }))
  assert.deepEqual(adjacencyBreaks(rows, { ...PARAMS, windowSeconds: 60 }), [false, false, false, false, false, false])
  assert.equal(last(runDetection(rows, PARAMS)).triggered, true)
})
