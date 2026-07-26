import { runDetection, computeBaseline, DEFAULT_PARAMS } from '@faultline/core'

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

/**
 * FAULTLINE: sustained multi-signal convergence scored by R.
 */
export function faultlineDetector(windows, params = BENCH_PARAMS) {
  const result = runDetection(windows, params)
  return {
    firedAt: result.detectionWindow?.window_number ?? null,
    peakR: Math.max(...result.windows.map((w) => w.R_score)),
  }
}

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
  { key: 'faultline', label: 'FAULTLINE', run: (w) => faultlineDetector(w) },
  { key: 'faultline_strict', label: 'FAULTLINE strict', run: (w) => faultlineDetector(w, STRICT_PARAMS) },
  { key: 'static_slo', label: 'Static SLO (3x)', run: (w) => staticSloDetector(w) },
  { key: 'single_3sigma', label: 'Single metric 3σ', run: (w) => singleMetricDetector(w) },
  { key: 'sustained_3sigma', label: 'Sustained 3σ', run: (w) => sustainedSingleMetricDetector(w) },
]
