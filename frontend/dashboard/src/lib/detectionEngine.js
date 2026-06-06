// FAULTLINE detection engine — real, in-browser math.
//
// This module is the actual implementation of the detection described in the
// README. Nothing here is precomputed: given raw telemetry values it derives
// the z-scores, qualifies sustained signals, computes the cascade risk score,
// and decides when detection fires. Every number the dashboard shows can be
// re-derived from the raw inputs by these pure functions — that is what makes
// the "auditable math" claim true rather than asserted.

export const DEFAULT_PARAMS = {
  baselineWindows: 4, // first N windows establish the healthy baseline
  zThreshold: 2.0, // a metric is elevated at >= 2 sigma
  minSustain: 2, // ...but only qualifies once sustained for >= 2 windows
  sigmaFloorRatio: 0.1, // floor sigma at 10% of baseline mean (prevents a tight
  //                       baseline from exploding z-scores into nonsense)
  criticalityWeight: 1.0, // W in the risk formula; per-service criticality
  triggerThreshold: 3.0, // R >= 3.0 => cascade pattern detected
  outageThreshold: 9.0, // R >= 9.0 => modeled outage
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

// Establish baseline mean/sigma per metric from the first `baselineWindows`
// healthy windows. Sigma is floored so a quiet baseline can't manufacture
// huge z-scores from small absolute movements.
export function computeBaseline(values, params = DEFAULT_PARAMS) {
  const slice = values.slice(0, params.baselineWindows)
  const mu = mean(slice)
  const rawSigma = stdev(slice, mu)
  const sigma = Math.max(rawSigma, Math.abs(mu) * params.sigmaFloorRatio, 1e-9)
  return { mean: mu, sigma, rawSigma }
}

// z = (value - mean) / sigma, the textbook normalization.
export function zScore(value, baseline) {
  return (value - baseline.mean) / baseline.sigma
}

// Walk a metric's z-series and decide, at each window, whether it qualifies:
// elevated (z >= threshold) AND sustained for >= minSustain consecutive windows.
function qualifyMetric(zSeries, params) {
  let run = 0
  return zSeries.map((z) => {
    if (z >= params.zThreshold) run += 1
    else run = 0
    return { z, sustained: run, qualified: run >= params.minSustain }
  })
}

// R = mean_z(qualified) × ln(1 + signal_count) × W
export function riskScore(qualifiedZ, params) {
  if (qualifiedZ.length === 0) return 0
  const meanZ = mean(qualifiedZ)
  return meanZ * Math.log(1 + qualifiedZ.length) * params.criticalityWeight
}

// Map a risk score to a 0..1 confidence with a saturating curve, so confidence
// climbs quickly past the trigger and asymptotes near certainty at outage scale.
export function confidenceFromRisk(R) {
  if (R <= 0) return 0
  return Math.min(0.99, Math.round((1 - Math.exp(-R / 2.5)) * 100) / 100)
}

// Run the full FAULTLINE detection over a raw telemetry series.
// `raw` = [{ window_number, window_timestamp, p99_latency, retry_rate, error_rate }, ...]
export function runDetection(raw, params = DEFAULT_PARAMS) {
  const baselines = {}
  const qualifiedSeries = {}

  for (const key of METRIC_KEYS) {
    const values = raw.map((w) => w[key])
    baselines[key] = computeBaseline(values, params)
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

// --- Baseline detectors: the incumbents FAULTLINE is meant to beat ----------
//
// These model how teams alert today, so we can quantify the lead-time edge.
//   1. Static SLO alert  — fires only when the OUTCOME metric (error rate)
//                          breaches its SLO. By then you are already failing.
//   2. Single-metric 3σ  — same z-math but no convergence/sustain logic; fires
//                          when ANY one metric first spikes to 3 sigma.
// FAULTLINE fires earlier because it reads the *convergence* of sustained
// signals, not any single metric crossing a line.
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

// Compare FAULTLINE against the incumbents and express the edge as lead time
// (in windows). Positive lead time = FAULTLINE fired earlier.
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

// --- Counterfactual: "what if an engineer acted?" --------------------------
//
// Models an SRE intervention at a chosen window. From the intervention window
// onward, each metric's excess over baseline decays geometrically (the drift is
// arrested and the system recovers) instead of continuing up the cascade. We
// then re-run the SAME deterministic engine on the modified telemetry, so the
// averted/mitigated verdict is real math, not a scripted animation.
//
// Per-metric decay encodes the mechanism: a circuit breaker on service-b mostly
// kills the retry storm and downstream errors, while latency drains more slowly
// as the connection pool recovers.
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

const METRIC_KEYS_LIST = ['p99_latency', 'retry_rate', 'error_rate']

// Return a new raw telemetry series with the mitigation applied from `window` on.
export function applyMitigation(raw, { window, mitigation = 'circuit_breaker', params = DEFAULT_PARAMS }) {
  const profile = MITIGATIONS[mitigation] ?? MITIGATIONS.circuit_breaker
  const baselineMean = {}
  for (const k of METRIC_KEYS_LIST) {
    baselineMean[k] = computeBaseline(raw.map((w) => w[k]), params).mean
  }
  const interventionRow = raw[window - 1] // window_number === window

  return raw.map((w) => {
    if (w.window_number < window) return { ...w }
    const steps = w.window_number - window
    const out = { ...w }
    for (const k of METRIC_KEYS_LIST) {
      const excess = interventionRow[k] - baselineMean[k]
      const decayed = excess * Math.pow(profile.decay[k], steps)
      out[k] = round2(baselineMean[k] + Math.max(decayed, 0))
    }
    return out
  })
}

// Run a full counterfactual: apply the mitigation, re-detect, and summarize the
// outcome against the unmitigated cascade.
export function runCounterfactual(raw, { window, mitigation = 'circuit_breaker', params = DEFAULT_PARAMS } = {}) {
  const baseline = runDetection(raw, params)
  const mitigatedRaw = applyMitigation(raw, { window, mitigation, params })
  const detection = runDetection(mitigatedRaw, params)

  const triggeredAt = detection.detectionWindow?.window_number ?? null
  const outageAt = detection.outageWindow?.window_number ?? null
  const peakR = Math.max(...detection.windows.map((w) => w.R_score))
  const baselineTriggeredAt = baseline.detectionWindow?.window_number ?? null

  // Averted: the cascade that *would* have triggered now never does, because we
  // acted before the original trigger window.
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
