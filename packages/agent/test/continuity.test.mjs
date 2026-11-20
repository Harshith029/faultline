import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RollingDetector } from '../src/detector.js'
import { silentLogger } from '../src/logger.js'

// The rolling buffer is only meaningful as a sequence of distinct, ordered,
// adjacent observations. These tests pin down what happens to samples that are
// not: replays, late arrivals, holes, clock skew, and stale restored state.

const METRICS = ['p99_latency', 'retry_rate', 'error_rate']
const PARAMS = {
  baselineWindows: 4,
  minSustain: 2,
  minSignals: 2,
  zThreshold: 2,
  triggerThreshold: 3,
  criticalityWeight: 1,
  sigmaFloorRatio: 0.1,
  metrics: METRICS,
  outageThreshold: Number.POSITIVE_INFINITY,
}

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)
const minute = (m) => T0 + m * 60_000
const iso = (m) => new Date(minute(m)).toISOString()

const detectorWith = (overrides = {}) =>
  new RollingDetector({ params: PARAMS, historyWindows: 20, intervalSeconds: 60, logger: silentLogger, ...overrides })

const calm = (m, service = 'api') => ({ service, timestamp: iso(m), p99_latency: 100, retry_rate: 1, error_rate: 0.5 })
const hot = (m, service = 'api') => ({ service, timestamp: iso(m), p99_latency: 400, retry_rate: 6, error_rate: 4 })

// One sample, received a few seconds after the source observed it.
const deliver = (detector, sample) => detector.ingest([sample], { nowMs: Date.parse(sample.timestamp) + 5_000 })

const evaluationOf = (results, service = 'api') =>
  results.find((r) => r.service === service && r.status === 'evaluated')?.evaluation

// --- replays ----------------------------------------------------------------

test('a replayed sample cannot satisfy minSustain', () => {
  const detector = detectorWith()
  for (let m = 0; m < 5; m++) deliver(detector, calm(m))
  assert.equal(evaluationOf(deliver(detector, hot(5))).triggered, false)

  // A source re-delivering its latest datapoint on the next two ticks — what a
  // CloudWatch query does while the next period has not been published. Counting
  // those would turn one elevated minute into three "sustained" windows.
  assert.deepEqual(detector.ingest([hot(5)], { nowMs: minute(6) }), [])
  assert.deepEqual(detector.ingest([hot(5)], { nowMs: minute(7) }), [])

  assert.equal(detector.buffer.size('api'), 6)
  assert.equal(detector.dataQuality(minute(7)).duplicateSamples, 2)
  assert.equal(detector.detectionFor('api').windows.at(-1).triggered, false)

  // A genuinely new, adjacent observation still completes the run.
  assert.equal(evaluationOf(deliver(detector, hot(6))).triggered, true)
})

test('a duplicate does not refresh the service as if new data had arrived', () => {
  const detector = detectorWith()
  deliver(detector, calm(0))
  detector.ingest([calm(0)], { nowMs: minute(10) })

  const [fresh] = detector.freshness(minute(10))
  assert.equal(fresh.staleSeconds, 600, 'freshness still dates from the original observation')
})

// --- late and future samples -------------------------------------------------

test('an observation older than the newest buffered one is dropped', () => {
  const detector = detectorWith()
  for (let m = 0; m < 5; m++) deliver(detector, calm(m))

  assert.deepEqual(detector.ingest([calm(2)], { nowMs: minute(6) }), [])
  assert.equal(detector.buffer.size('api'), 5)
  assert.equal(detector.dataQuality(minute(6)).outOfOrderSamples, 1)
})

test('a sample stamped well in the future is rejected instead of reordering history', () => {
  const detector = detectorWith()
  deliver(detector, calm(0))

  // Two hours ahead of the agent's clock. Accepting it would make every honest
  // sample after it look out of order.
  const [result] = detector.ingest([calm(120)], { nowMs: minute(1) })
  assert.equal(result.status, 'incomplete_sample')
  assert.deepEqual(result.missing, ['timestamp'])
  assert.equal(detector.buffer.size('api'), 1)

  deliver(detector, calm(1))
  assert.equal(detector.buffer.size('api'), 2)
})

test('samples the agent stamps on receipt are never mistaken for duplicates', () => {
  const detector = detectorWith()
  const unstamped = { service: 'api', p99_latency: 100, retry_rate: 1, error_rate: 0.5 }

  // Several collections in the same millisecond, as a burst of ticks produces.
  // Without a source timestamp each collection is its own observation.
  for (let i = 0; i < 3; i++) detector.ingest([unstamped], { nowMs: minute(0) })

  assert.equal(detector.buffer.size('api'), 3)
  assert.equal(detector.dataQuality(minute(0)).duplicateSamples, 0)
})

// --- holes in the telemetry -------------------------------------------------

test('a missing minute breaks a sustained run', () => {
  const detector = detectorWith()
  for (let m = 0; m < 5; m++) deliver(detector, calm(m))
  deliver(detector, hot(5))

  // Minute 6 never arrived. Elevated at 5 and at 7 is not two consecutive minutes.
  const afterHole = deliver(detector, hot(7))
  assert.equal(evaluationOf(afterHole).triggered, false)
  assert.equal(detector.detectionFor('api').windows.at(-1).gap_before, true)
  assert.equal(detector.dataQuality(minute(7)).sampleGaps, 1)

  assert.equal(evaluationOf(deliver(detector, hot(8))).triggered, true)
})

test('a source coarser than the collection interval is judged by its own spacing', () => {
  // Polled every 15 s, but the source only has a new datapoint each minute: the
  // replays are dropped, and what remains is one sample a minute. Judged against
  // 15 s every one of those would be a gap and no signal could ever sustain.
  const detector = detectorWith({ intervalSeconds: 15 })
  for (let m = 0; m < 5; m++) deliver(detector, calm(m))
  deliver(detector, hot(5))

  assert.equal(evaluationOf(deliver(detector, hot(6))).triggered, true)
  assert.equal(detector.dataQuality(minute(6)).sampleGaps, 0)
  assert.equal(detector.spacingSeconds('api'), 60)
})

test('a hole is still a hole relative to the source\'s own spacing', () => {
  const detector = detectorWith({ intervalSeconds: 15 })
  for (let m = 0; m < 5; m++) deliver(detector, calm(m))
  deliver(detector, hot(5))

  // Three minutes on a one-minute series: two observations are missing.
  assert.equal(evaluationOf(deliver(detector, hot(8))).triggered, false)
  assert.equal(detector.dataQuality(minute(8)).sampleGaps, 1)
})

test('an explicit maxSampleGapSeconds overrides the inferred tolerance', () => {
  const detector = detectorWith({ maxSampleGapSeconds: 200 })
  for (let m = 0; m < 5; m++) deliver(detector, calm(m))
  deliver(detector, hot(5))

  // 180 s is a hole by the default rule (1.5 × 60 s), adjacent under 200 s.
  assert.equal(evaluationOf(deliver(detector, hot(8))).triggered, true)
})

test('a source timestamp is never judged against a receipt stamp', () => {
  const detector = detectorWith()
  // A row without a timestamp, stamped on receipt five seconds into minute 5…
  detector.ingest([{ service: 'api', p99_latency: 100, retry_rate: 1, error_rate: 0.5 }], {
    nowMs: minute(5) + 5_000,
  })
  // …then a row carrying its real observation time, which is earlier than that
  // receipt. It is a new observation, not a late one.
  detector.ingest([calm(5)], { nowMs: minute(6) })

  assert.equal(detector.buffer.size('api'), 2)
  assert.equal(detector.dataQuality(minute(6)).outOfOrderSamples, 0)
})

test('a replay is still recognised against restored state after a restart', () => {
  const detector = detectorWith()
  detector.hydrateBuffers(
    [{ service: 'api', samples: [{ ...calm(0), sourceStamped: true }, { ...calm(1), sourceStamped: true }] }],
    { nowMs: minute(2) }
  )

  // The source re-delivers the last datapoint it had before the restart.
  assert.deepEqual(detector.ingest([calm(1)], { nowMs: minute(2) }), [])
  assert.equal(detector.dataQuality(minute(2)).duplicateSamples, 1)
  assert.equal(detector.buffer.size('api'), 2)
})

test('a hole longer than the whole history span starts the service over', () => {
  // 20 windows × 60 s: the buffer is meant to hold the last 20 minutes.
  const detector = detectorWith({ historyWindows: 20 })
  for (let m = 0; m < 8; m++) deliver(detector, calm(m))

  const [result] = deliver(detector, calm(60))

  assert.equal(result.status, 'warming_up')
  assert.equal(detector.buffer.size('api'), 1)
  assert.equal(detector.detectionFor('api'), null)
  assert.equal(detector.dataQuality(minute(60)).historyResets, 1)
})

// --- restored state -----------------------------------------------------------

test('restored samples must satisfy the current metric configuration', () => {
  // The saved buffers predate queue_depth being added to the config.
  const detector = detectorWith({ params: { ...PARAMS, metrics: [...METRICS, 'queue_depth'] } })

  const outcome = detector.hydrateBuffers([{ service: 'api', samples: [calm(0), calm(1)] }], { nowMs: minute(2) })

  assert.deepEqual(outcome, { samples: 0, dropped: 2 })
  assert.equal(detector.buffer.size('api'), 0)

  // The detector keeps working rather than throwing on the old samples later.
  const [result] = detector.ingest([{ ...calm(3), queue_depth: 5 }], { nowMs: minute(3) })
  assert.equal(result.status, 'warming_up')
})

test('restored samples that are out of order are dropped', () => {
  const detector = detectorWith()
  const outcome = detector.hydrateBuffers(
    [{ service: 'api', samples: [calm(0), calm(2), calm(1), calm(3)] }],
    { nowMs: minute(4) }
  )

  assert.deepEqual(outcome, { samples: 3, dropped: 1 })
  assert.deepEqual(
    detector.buffer.get('api').map((s) => s.timestamp),
    [iso(0), iso(2), iso(3)]
  )
})

test('restored samples sharing a timestamp are kept, because ingest never buffers a replay', () => {
  // Receipt-stamped collections that landed in the same millisecond. A source
  // replay with an equal timestamp is dropped at ingest, so it cannot be here.
  const detector = detectorWith()
  const outcome = detector.hydrateBuffers(
    [{ service: 'api', samples: [calm(0), calm(1), calm(1), calm(2)] }],
    { nowMs: minute(3) }
  )
  assert.deepEqual(outcome, { samples: 4, dropped: 0 })
})

test('one service failing evaluation does not stop the others being evaluated', () => {
  const detector = detectorWith()
  for (let m = 0; m < 6; m++) detector.ingest([calm(m, 'api'), calm(m, 'worker')], { nowMs: minute(m) + 5_000 })

  // Corrupt one buffered sample directly, as a bug or a bad restore might.
  delete detector.buffer.get('worker')[2].error_rate

  const results = detector.ingest([calm(6, 'api'), calm(6, 'worker')], { nowMs: minute(6) + 5_000 })

  assert.equal(results.find((r) => r.service === 'api').status, 'evaluated')
  const worker = results.find((r) => r.service === 'worker')
  assert.equal(worker.status, 'evaluation_failed')
  assert.match(worker.error, /error_rate/)
  assert.equal(detector.dataQuality(minute(6)).evaluationErrors, 1)
})
