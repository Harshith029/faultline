export const DEFAULT_PARAMS = {
  baselineWindows: 4,
  zThreshold: 2.0,
  minSustain: 2,
  sigmaFloorRatio: 0.1,
  criticalityWeight: 1.0,
  triggerThreshold: 3.0,
  outageThreshold: 9.0,
}

const METRIC_KEYS = ['p99_latency', 'retry_rate', 'error_rate']

export const METRIC_META = {
  p99_latency: { label: 'P99 latency', unit: 'ms', zKey: 'p99_latency_z' },
  retry_rate: { label: 'Retry rate', unit: '%', zKey: 'retry_rate_z' },
  error_rate: { label: 'Error rate', unit: '%', zKey: 'error_rate_z' },
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

const stdev = (xs, mu) =>
  Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length)

export function computeBaseline(values, params = DEFAULT_PARAMS) {
  const slice = values.slice(0, params.baselineWindows)
  const mu = mean(slice)
  const rawSigma = stdev(slice, mu)
  const sigma = Math.max(rawSigma, Math.abs(mu) * params.sigmaFloorRatio, 1e-9)
  return { mean: mu, sigma, rawSigma }
}

export function zScore(value, baseline) {
  return (value - baseline.mean) / baseline.sigma
}

function qualifyMetric(zSeries, params) {
  let run = 0
  return zSeries.map((z) => {
    if (z >= params.zThreshold) run += 1
    else run = 0
    return { z, sustained: run, qualified: run >= params.minSustain }
  })
}

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
  const baselines = {}
  const qualifiedSeries = {}

  for (const key of METRIC_KEYS) {
    const values = raw.map((w) => w[key])
    const base = computeBaseline(values, params)
    const absFloor = params.sigmaFloorAbs?.[key] ?? 0
    baselines[key] = absFloor > base.sigma ? { ...base, sigma: absFloor } : base
    const zs = values.map((v) => zScore(v, baselines[key]))
    qualifiedSeries[key] = qualifyMetric(zs, params)
  }

  const windows = raw.map((w, i) => {
    const z = {}
    const qualified_signals = []
    for (const key of METRIC_KEYS) {
      const cell = qualifiedSeries[key][i]
      z[key] = cell.z
      if (cell.qualified) {
        qualified_signals.push({
          metric: METRIC_META[key].zKey,
          z_score: round1(cell.z),
          windows_sustained: cell.sustained,
        })
      }
    }

    const R = riskScore(qualified_signals.map((s) => s.z_score), params)
    const triggered = R >= params.triggerThreshold
    const outage = R >= params.outageThreshold

    return {
      service_id: w.service_id ?? 'B',
      window_number: w.window_number,
      window_timestamp: w.window_timestamp,
      raw: {
        p99_latency: w.p99_latency,
        retry_rate: w.retry_rate,
        error_rate: w.error_rate,
      },
      metrics: {
        p99_latency_z: round2(z.p99_latency),
        retry_rate_z: round2(z.retry_rate),
        error_rate_z: round2(z.error_rate),
      },
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

  const staticSLO = windows.find((w) => w.raw.error_rate >= sloErrorRatePct) ?? null
  const singleMetric = windows.find((w) =>
    Object.values(w.metrics).some((z) => z >= singleMetricZ)
  ) ?? null

  return {
    staticSLO: staticSLO
      ? { window: staticSLO.window_number, rule: `error rate ≥ ${sloErrorRatePct}%` }
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
  const baselineMean = {}
  for (const k of METRIC_KEYS) {
    baselineMean[k] = computeBaseline(raw.map((w) => w[k]), params).mean
  }
  const interventionRow = raw[window - 1]

  return raw.map((w) => {
    if (w.window_number < window) return { ...w }
    const steps = w.window_number - window
    const out = { ...w }
    for (const k of METRIC_KEYS) {
      const excess = interventionRow[k] - baselineMean[k]
      const decayed = excess * Math.pow(profile.decay[k], steps)
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
