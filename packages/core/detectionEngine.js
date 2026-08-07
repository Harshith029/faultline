export const DEFAULT_PARAMS = {
  baselineWindows: 4,
  zThreshold: 2.0,
  minSustain: 2,
  sigmaFloorRatio: 0.1,
  criticalityWeight: 1.0,
  triggerThreshold: 3.0,
  outageThreshold: 9.0,
  minSignals: 2,
  metrics: ['p99_latency', 'retry_rate', 'error_rate'],
  sloMetric: 'error_rate',
  // 'mean_sigma' (classic z-score) or 'median_mad' (robust to spiky channels).
  statistic: 'mean_sigma',
}

const METRIC_KEYS = DEFAULT_PARAMS.metrics

export const METRIC_META = {
  p99_latency: { label: 'P99 latency', unit: 'ms', zKey: 'p99_latency_z' },
  retry_rate: { label: 'Retry rate', unit: '%', zKey: 'retry_rate_z' },
  error_rate: { label: 'Error rate', unit: '%', zKey: 'error_rate_z' },
}

const humanize = (metric) =>
  metric.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/**
 * Descriptor for any metric, including ones this project has never seen.
 * The engine is metric-agnostic: `params.metrics` decides what is analyzed.
 */
export function metricMeta(metric) {
  return METRIC_META[metric] ?? { label: humanize(metric), unit: '', zKey: `${metric}_z` }
}

const metricsOf = (params) =>
  Array.isArray(params?.metrics) && params.metrics.length > 0 ? params.metrics : METRIC_KEYS

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

const stdev = (xs, mu) =>
  Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length)

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Scaling MAD by this constant makes it a consistent estimator of the standard
// deviation for normally distributed data, so thresholds stay comparable
// whichever statistic is in use.
const MAD_TO_SIGMA = 1.4826

/**
 * Baseline centre and spread for a metric.
 *
 * `statistic: 'median_mad'` swaps mean/standard-deviation for median/MAD.
 * Mean and sigma are both badly non-robust: a handful of ordinary spikes in a
 * bursty channel inflates sigma and suppresses every later score. Median and
 * MAD have a 50% breakdown point, so the same spikes barely move them.
 *
 * `mean` holds the centre estimate under either statistic, so every consumer
 * downstream is unaffected by the choice.
 */
export function computeBaseline(values, params = DEFAULT_PARAMS) {
  const slice = values.slice(0, params.baselineWindows)

  if (params.statistic === 'median_mad') {
    const centre = median(slice)
    const scale = MAD_TO_SIGMA * median(slice.map((v) => Math.abs(v - centre)))
    const sigma = Math.max(scale, Math.abs(centre) * params.sigmaFloorRatio, 1e-9)
    return { mean: centre, sigma, rawSigma: scale, statistic: 'median_mad' }
  }

  const mu = mean(slice)
  const rawSigma = stdev(slice, mu)
  const sigma = Math.max(rawSigma, Math.abs(mu) * params.sigmaFloorRatio, 1e-9)
  return { mean: mu, sigma, rawSigma, statistic: 'mean_sigma' }
}

export function zScore(value, baseline) {
  return (value - baseline.mean) / baseline.sigma
}

function qualifyMetric(zSeries, params, threshold = params.zThreshold) {
  let run = 0
  return zSeries.map((z) => {
    if (z >= threshold) run += 1
    else run = 0
    return { z, sustained: run, qualified: run >= params.minSustain }
  })
}

/**
 * The sigma level at which a metric counts as elevated.
 *
 * `zThresholdPerMetric` lets a naturally bursty channel demand more evidence
 * than a rock-steady one, instead of holding every channel to a single global
 * number. Falls back to `zThreshold` for anything unlisted.
 */
const thresholdFor = (metric, params) =>
  params.zThresholdPerMetric?.[metric] ?? params.zThreshold

export function riskScore(qualifiedZ, params) {
  if (qualifiedZ.length === 0) return 0
  const meanZ = mean(qualifiedZ)
  return meanZ * Math.log(1 + qualifiedZ.length) * params.criticalityWeight
}

export function confidenceFromRisk(R) {
  if (R <= 0) return 0
  return Math.min(0.99, Math.round((1 - Math.exp(-R / 2.5)) * 100) / 100)
}

export function runDetection(raw, params = DEFAULT_PARAMS) {
  const metrics = metricsOf(params)
  const baselines = {}
  const qualifiedSeries = {}

  for (const key of metrics) {
    const values = raw.map((w) => Number(w[key]) || 0)
    const base = computeBaseline(values, params)
    const absFloor = params.sigmaFloorAbs?.[key] ?? 0
    baselines[key] = absFloor > base.sigma ? { ...base, sigma: absFloor } : base
    const zs = values.map((v) => zScore(v, baselines[key]))
    qualifiedSeries[key] = qualifyMetric(zs, params, thresholdFor(key, params))
  }

  const windows = raw.map((w, i) => {
    const rawValues = {}
    const zValues = {}
    const qualified_signals = []

    for (const key of metrics) {
      const cell = qualifiedSeries[key][i]
      rawValues[key] = w[key]
      zValues[metricMeta(key).zKey] = round2(cell.z)
      if (cell.qualified) {
        qualified_signals.push({
          metric: metricMeta(key).zKey,
          z_score: round1(cell.z),
          windows_sustained: cell.sustained,
        })
      }
    }

    const R = riskScore(qualified_signals.map((s) => s.z_score), params)
    const converged = qualified_signals.length >= (params.minSignals ?? 1)
    const triggered = converged && R >= params.triggerThreshold
    const outage = triggered && R >= params.outageThreshold

    return {
      service_id: w.service_id ?? 'B',
      window_number: w.window_number,
      window_timestamp: w.window_timestamp,
      raw: rawValues,
      metrics: zValues,
      qualified_signals,
      signal_count: qualified_signals.length,
      R_score: round2(R),
      confidence: confidenceFromRisk(R),
      triggered,
      outage,
    }
  })

  const detectionWindow = windows.find((w) => w.triggered) ?? null
  const outageWindow = windows.find((w) => w.outage) ?? null

  return { windows, baselines, params, detectionWindow, outageWindow }
}

export function runBaselineDetectors(detectionResult, opts = {}) {
  const { windows } = detectionResult
  const sloErrorRatePct = opts.sloErrorRatePct ?? 2.0
  const singleMetricZ = opts.singleMetricZ ?? 3.0
  const sloMetric = opts.sloMetric ?? detectionResult.params?.sloMetric ?? 'error_rate'

  const staticSLO =
    windows.find((w) => Number(w.raw?.[sloMetric]) >= sloErrorRatePct) ?? null
  const singleMetric = windows.find((w) =>
    Object.values(w.metrics).some((z) => z >= singleMetricZ)
  ) ?? null

  return {
    staticSLO: staticSLO
      ? { window: staticSLO.window_number, rule: `${metricMeta(sloMetric).label.toLowerCase()} ≥ ${sloErrorRatePct}` }
      : null,
    singleMetric: singleMetric
      ? { window: singleMetric.window_number, rule: `any single metric ≥ ${singleMetricZ}σ` }
      : null,
  }
}

export function compareDetectors(detectionResult, opts = {}) {
  const faultline = detectionResult.detectionWindow?.window_number ?? null
  const baselines = runBaselineDetectors(detectionResult, opts)

  const leadOver = (baselineWindow) =>
    faultline != null && baselineWindow != null ? baselineWindow - faultline : null

  return {
    faultlineWindow: faultline,
    staticSLO: baselines.staticSLO && {
      ...baselines.staticSLO,
      leadWindows: leadOver(baselines.staticSLO.window),
    },
    singleMetric: baselines.singleMetric && {
      ...baselines.singleMetric,
      leadWindows: leadOver(baselines.singleMetric.window),
    },
  }
}

export const MITIGATIONS = {
  circuit_breaker: {
    label: 'Engage circuit breaker on service-b',
    decay: { p99_latency: 0.62, retry_rate: 0.35, error_rate: 0.3 },
  },
  scale_pool: {
    label: 'Scale out connection pool',
    decay: { p99_latency: 0.45, retry_rate: 0.55, error_rate: 0.5 },
  },
  shed_load: {
    label: 'Shed load / rate-limit clients',
    decay: { p99_latency: 0.55, retry_rate: 0.3, error_rate: 0.45 },
  },
}

export function applyMitigation(raw, { window, mitigation = 'circuit_breaker', params = DEFAULT_PARAMS }) {
  const profile = MITIGATIONS[mitigation] ?? MITIGATIONS.circuit_breaker
  const metrics = metricsOf(params)
  const baselineMean = {}
  for (const k of metrics) {
    baselineMean[k] = computeBaseline(raw.map((w) => Number(w[k]) || 0), params).mean
  }
  const interventionRow = raw[window - 1]

  return raw.map((w) => {
    if (w.window_number < window) return { ...w }
    const steps = w.window_number - window
    const out = { ...w }
    for (const k of metrics) {
      // Metrics with no explicit recovery profile fall back to a moderate decay.
      const rate = profile.decay[k] ?? 0.5
      const excess = (Number(interventionRow[k]) || 0) - baselineMean[k]
      const decayed = excess * Math.pow(rate, steps)
      out[k] = round2(baselineMean[k] + Math.max(decayed, 0))
    }
    return out
  })
}

export function runCounterfactual(raw, { window, mitigation = 'circuit_breaker', params = DEFAULT_PARAMS } = {}) {
  const baseline = runDetection(raw, params)
  const mitigatedRaw = applyMitigation(raw, { window, mitigation, params })
  const detection = runDetection(mitigatedRaw, params)

  const triggeredAt = detection.detectionWindow?.window_number ?? null
  const outageAt = detection.outageWindow?.window_number ?? null
  const peakR = Math.max(...detection.windows.map((w) => w.R_score))
  const baselineTriggeredAt = baseline.detectionWindow?.window_number ?? null

  const averted =
    baselineTriggeredAt != null && (triggeredAt == null || window <= baselineTriggeredAt) && outageAt == null && triggeredAt == null
  const tooLate = triggeredAt != null && window >= baselineTriggeredAt

  let verdict
  if (averted) {
    verdict = { status: 'averted', label: 'Cascade averted — detection never fires' }
  } else if (tooLate && outageAt == null) {
    verdict = { status: 'mitigated', label: `Triggered at W${triggeredAt} — too late to prevent, but outage avoided` }
  } else if (outageAt != null) {
    verdict = { status: 'failed', label: `Acted too late — outage still reached at W${outageAt}` }
  } else {
    verdict = { status: 'mitigated', label: 'Severity reduced' }
  }

  return {
    mitigation,
    window,
    mitigatedRaw,
    detection,
    triggeredAt,
    outageAt,
    peakR: round2(peakR),
    baselineTriggeredAt,
    baselineOutageAt: baseline.outageWindow?.window_number ?? null,
    averted,
    verdict,
  }
}

function round1(x) {
  return Math.round(x * 10) / 10
}
function round2(x) {
  return Math.round(x * 100) / 100
}
