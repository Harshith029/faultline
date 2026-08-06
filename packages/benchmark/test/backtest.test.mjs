import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreDetections, rollingDetect, smdParams, DETECTORS } from '../src/backtest.js'
import { labelSegments, availableMachines } from '../src/datasets/smd.js'

const L = (pattern) => [...pattern].map((c) => (c === '1' ? 1 : 0))
const B = (pattern) => [...pattern].map((c) => c === '1')

test('labelSegments finds contiguous incidents', () => {
  assert.deepEqual(labelSegments(L('0011100')), [{ start: 2, end: 4, length: 3 }])
  assert.equal(labelSegments(L('0110011')).length, 2)
  assert.equal(labelSegments(L('0000')).length, 0)
  // A segment running to the end of the series is still a segment.
  assert.deepEqual(labelSegments(L('0001')), [{ start: 3, end: 3, length: 1 }])
})

test('firing anywhere inside an incident counts as catching it', () => {
  const score = scoreDetections(B('0000100'), L('0011100'))
  assert.equal(score.detectedSegments, 1)
  assert.equal(score.recall, 1)
  assert.equal(score.falsePositiveEpisodes, 0)
})

test('firing for a whole outage is one alert, not many', () => {
  const score = scoreDetections(B('0011111'), L('0011111'))
  assert.equal(score.episodes, 1, 'a contiguous run of firing is a single alert')
  assert.equal(score.precision, 1)
})

test('a contiguous run outside any incident is one false positive', () => {
  const score = scoreDetections(B('1111000'), L('0000011'))
  assert.equal(score.falsePositiveEpisodes, 1)
  assert.equal(score.detectedSegments, 0)
  assert.equal(score.recall, 0)
  assert.equal(score.precision, 0)
})

test('detection delay is measured from the start of the incident', () => {
  const score = scoreDetections(B('0000010'), L('0011110'))
  assert.equal(score.medianDelayWindows, 3)
})

test('a detector that never fires scores zero recall, not an error', () => {
  const score = scoreDetections(B('0000000'), L('0011100'))
  assert.equal(score.recall, 0)
  assert.equal(score.precision, null)
  assert.equal(score.f1, 0)
})

test('a perfectly silent series with no incidents has no false positives', () => {
  const score = scoreDetections(B('0000'), L('0000'))
  assert.equal(score.segments, 0)
  assert.equal(score.falsePositiveEpisodes, 0)
})

test('rollingDetect never lets a detector see the future', () => {
  const metrics = ['a', 'b']
  const params = smdParams(metrics, { baselineWindows: 4, minSustain: 2 })
  const windows = Array.from({ length: 30 }, (_, i) => ({
    window_number: i + 1,
    a: i < 20 ? 0.1 : 5,
    b: i < 20 ? 0.1 : 5,
  }))

  const seen = []
  rollingDetect(windows, {
    metrics,
    params,
    historyWindows: 10,
    detector: (buffer) => {
      seen.push(buffer[buffer.length - 1].window_number)
      assert.ok(buffer.length <= 10, 'buffer must respect historyWindows')
      return false
    },
  })

  // Evaluation starts only once enough history exists, and advances one window
  // at a time without skipping ahead.
  assert.equal(seen[0], params.baselineWindows + params.minSustain)
  assert.equal(seen.at(-1), 30)
})

test('rollingDetect detects a sustained multi-channel shift', () => {
  const metrics = ['a', 'b', 'c']
  const params = smdParams(metrics, { baselineWindows: 6, minSustain: 2, minSignals: 2 })
  const windows = Array.from({ length: 40 }, (_, i) => ({
    window_number: i + 1,
    a: 0.2 + (i % 2) * 0.01 + (i >= 25 ? 0.5 : 0),
    b: 0.3 + (i % 3) * 0.01 + (i >= 25 ? 0.6 : 0),
    c: 0.1 + (i % 2) * 0.01,
  }))

  const fired = rollingDetect(windows, {
    metrics,
    params,
    historyWindows: 40,
    detector: DETECTORS.faultline,
  })
  assert.ok(fired.some(Boolean), 'a two-channel sustained shift should fire')
  assert.equal(fired.slice(0, 25).some(Boolean), false, 'nothing should fire before the shift')
})

test('smdParams applies an absolute sigma floor to every channel', () => {
  const params = smdParams(['x', 'y'])
  assert.equal(params.sigmaFloorAbs.x, 0.01)
  assert.equal(params.sigmaFloorAbs.y, 0.01)
  assert.deepEqual(params.metrics, ['x', 'y'])
})

test('availableMachines reports an empty list when the dataset is absent', () => {
  // CI has no dataset checked in; this must degrade quietly rather than throw.
  assert.ok(Array.isArray(availableMachines('does/not/exist')))
  assert.equal(availableMachines('does/not/exist').length, 0)
})
