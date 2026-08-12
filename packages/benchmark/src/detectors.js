import { runDetection, computeBaseline, DEFAULT_PARAMS } from '@faultline/core'
import { RollingDetector } from '@faultline/agent/src/detector.js'

export const BENCH_PARAMS = {
  ...DEFAULT_PARAMS,
  baselineWindows: 12,
  minSustain: 2,
  zThreshold: 2.0,
  triggerThreshold: 3.0,
  // Scenario noise is generated above this floor, so "+3 sigma" stays literal.
  sigmaFloorRatio: 0.05,
  outageThreshold: Number.POSITIVE_INFINITY,
}

const METRICS = ['p99_latency', 'retry_rate', 'error_rate']

const firstIndex = (windows, predicate) => {
  for (let i = 0; i < windows.length; i++) if (predicate(windows[i], i)) return i + 1
  return null
}

// The rolling buffer the deployed agent uses. Sized as the agent's default so
// the benchmark measures the configuration people actually run.
export const BENCH_HISTORY_WINDOWS = 40

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * FIXED-BASELINE REFERENCE — not what the agent does.
 *
 * Hands the entire scenario to `runDetection` in one call, so the baseline is
 * the first `baselineWindows` of the whole series and never moves. That is a
 * useful reference number for comparing detector shapes on identical data, but
 * it is not the deployed behaviour and must not be reported as if it were.
 */
export function faultlineFixedBaselineDetector(windows, params = BENCH_PARAMS) {
  const result = runDetection(windows, params)
  return {
    firedAt: result.detectionWindow?.window_number ?? null,
    peakR: Math.max(...result.windows.map((w) => w.R_score)),
  }
}

/**
 * DEPLOYED BEHAVIOUR — the agent's incremental rolling detector.
 *
 * Feeds windows one at a time through the same `RollingDetector` the agent
 * runs, so the baseline ages out of a bounded buffer exactly as it does in
 * production. This matters most for long incidents and deploy step changes: a
 * fixed baseline never absorbs the new normal, whereas a rolling one eventually
 * does and stops firing. Benchmarking the fixed variant therefore flatters the
 * agent on precisely the scenarios where it is weakest.
 */
export function faultlineRollingDetector(
  windows,
  params = BENCH_PARAMS,
  { historyWindows = BENCH_HISTORY_WINDOWS } = {}
) {
  const detector = new RollingDetector({ params, historyWindows, logger: silentLogger })

  let firedAt = null
  let peakR = 0

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]
    const [result] = detector.ingest([
      {
        service: 'bench',
        timestamp: w.window_timestamp ?? new Date(i * 60000).toISOString(),
        p99_latency: w.p99_latency,
        retry_rate: w.retry_rate,
        error_rate: w.error_rate,
      },
    ])

    if (result?.status !== 'evaluated') continue
    peakR = Math.max(peakR, result.evaluation.R_score)
    // The agent alerts on the first triggering tick, so the benchmark records
    // the same instant rather than scanning a completed series afterwards.
    if (firedAt === null && result.evaluation.triggered) firedAt = i + 1
  }

  return { firedAt, peakR }
}

/** Back-compat alias; the default detector is the deployed rolling one. */
export const faultlineDetector = faultlineRollingDetector

/**
 * The incumbent: alert when an outcome metric breaches a fixed SLO. Expressed
 * relative to baseline so it is comparable across scenarios rather than tuned
 * to one scale.
 */
export function staticSloDetector(windows, { multiple = 3 } = {}) {
  const baseline = computeBaseline(windows.map((w) => w.error_rate), BENCH_PARAMS)
  const limit = baseline.mean * multiple
  return { firedAt: firstIndex(windows, (w) => w.error_rate >= limit), limit }
}

/**
 * The other common approach: page when any single metric crosses N sigma, with
 * no requirement that it persist or that anything else agree.
 */
export function singleMetricDetector(windows, { sigma = 3 } = {}) {
  const baselines = {}
  for (const metric of METRICS) {
    baselines[metric] = computeBaseline(windows.map((w) => w[metric]), BENCH_PARAMS)
  }
  return {
    firedAt: firstIndex(windows, (w) =>
      METRICS.some((m) => (w[m] - baselines[m].mean) / baselines[m].sigma >= sigma)
    ),
  }
}

/**
 * Single metric crossing N sigma, but required to persist. Isolates how much of
 * FAULTLINE's advantage comes from the sustain rule versus from convergence.
 */
export function sustainedSingleMetricDetector(windows, { sigma = 3, sustain = 2 } = {}) {
  const baselines = {}
  for (const metric of METRICS) {
    baselines[metric] = computeBaseline(windows.map((w) => w[metric]), BENCH_PARAMS)
  }
  const runs = Object.fromEntries(METRICS.map((m) => [m, 0]))
  for (let i = 0; i < windows.length; i++) {
    for (const metric of METRICS) {
      const z = (windows[i][metric] - baselines[metric].mean) / baselines[metric].sigma
      runs[metric] = z >= sigma ? runs[metric] + 1 : 0
      if (runs[metric] >= sustain) return { firedAt: i + 1 }
    }
  }
  return { firedAt: null }
}

// Recommended for noisy or bursty environments: a two-window blip no longer
// counts as sustained. Costs roughly one window of detection delay.
export const STRICT_PARAMS = { ...BENCH_PARAMS, minSustain: 3 }

export const DETECTORS = [
  {
    key: 'faultline',
    label: 'FAULTLINE (agent, rolling)',
    deployed: true,
    run: (w) => faultlineRollingDetector(w),
  },
  {
    key: 'faultline_strict',
    label: 'FAULTLINE strict (agent, rolling)',
    deployed: true,
    run: (w) => faultlineRollingDetector(w, STRICT_PARAMS),
  },
  {
    key: 'faultline_fixed_baseline',
    label: 'FAULTLINE fixed-baseline (reference)',
    reference: true,
    run: (w) => faultlineFixedBaselineDetector(w),
  },
  { key: 'static_slo', label: 'Static SLO (3x)', run: (w) => staticSloDetector(w) },
  { key: 'single_3sigma', label: 'Single metric 3σ', run: (w) => singleMetricDetector(w) },
  { key: 'sustained_3sigma', label: 'Sustained 3σ', run: (w) => sustainedSingleMetricDetector(w) },
]
