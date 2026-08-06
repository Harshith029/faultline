import { runDetection, computeBaseline, DEFAULT_PARAMS } from '@faultline/core'
import { labelSegments } from './datasets/smd.js'

/**
 * Detection parameters for a normalized real dataset.
 *
 * SMD channels are already scaled to roughly 0..1 and many are near-constant,
 * so a purely relative sigma floor collapses to zero and manufactures enormous
 * z-scores. An absolute floor of 1% of the value range is the honest fix and is
 * applied identically to every detector under test.
 */
export function smdParams(metrics, overrides = {}) {
  return {
    ...DEFAULT_PARAMS,
    metrics,
    baselineWindows: 30,
    zThreshold: 2.0,
    minSustain: 2,
    minSignals: 2,
    triggerThreshold: 3.0,
    sigmaFloorRatio: 0.05,
    sigmaFloorAbs: Object.fromEntries(metrics.map((m) => [m, 0.01])),
    outageThreshold: Number.POSITIVE_INFINITY,
    ...overrides,
  }
}

const zOf = (value, baseline) => (value - baseline.mean) / baseline.sigma

/**
 * Replays a series the way the agent would: at every window, only the preceding
 * `historyWindows` samples are visible. No detector can see the future.
 */
export function rollingDetect(windows, { metrics, params, historyWindows = 120, detector }) {
  const fired = new Array(windows.length).fill(false)
  const minWindows = params.baselineWindows + params.minSustain

  for (let i = minWindows - 1; i < windows.length; i++) {
    const from = Math.max(0, i - historyWindows + 1)
    const buffer = windows.slice(from, i + 1)
    if (buffer.length < minWindows) continue
    fired[i] = detector(buffer, { metrics, params })
  }
  return fired
}

export const DETECTORS = {
  faultline: (buffer, { params }) => {
    const result = runDetection(buffer, params)
    return result.windows[result.windows.length - 1].triggered
  },

  single_3sigma: (buffer, { metrics, params }) => {
    const latest = buffer[buffer.length - 1]
    return metrics.some((m) => {
      const base = computeBaseline(buffer.map((w) => w[m]), params)
      const sigma = Math.max(base.sigma, params.sigmaFloorAbs?.[m] ?? 0)
      return zOf(latest[m], { mean: base.mean, sigma }) >= 3
    })
  },

  sustained_3sigma: (buffer, { metrics, params }) => {
    if (buffer.length < 2) return false
    const last = buffer[buffer.length - 1]
    const prev = buffer[buffer.length - 2]
    return metrics.some((m) => {
      const base = computeBaseline(buffer.map((w) => w[m]), params)
      const sigma = Math.max(base.sigma, params.sigmaFloorAbs?.[m] ?? 0)
      return zOf(last[m], { mean: base.mean, sigma }) >= 3 && zOf(prev[m], { mean: base.mean, sigma }) >= 3
    })
  },
}

const episodesOf = (fired) => {
  const episodes = []
  let start = null
  for (let i = 0; i < fired.length; i++) {
    if (fired[i] && start === null) start = i
    if (!fired[i] && start !== null) {
      episodes.push({ start, end: i - 1 })
      start = null
    }
  }
  if (start !== null) episodes.push({ start, end: fired.length - 1 })
  return episodes
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Segment-wise scoring, the convention used in the anomaly-detection literature
 * and the one that matches how operators actually experience alerts:
 *
 *  - An incident counts as caught if the detector fires at any point inside it.
 *    Firing on every minute of a two-hour outage is one alert, not a hundred.
 *  - A contiguous run of firing outside any labelled incident is one false
 *    positive, for the same reason.
 */
export function scoreDetections(fired, labels) {
  const segments = labelSegments(labels)
  const episodes = episodesOf(fired)

  const overlaps = (episode, segment) => episode.start <= segment.end && episode.end >= segment.start

  let detected = 0
  const delays = []
  for (const segment of segments) {
    const hit = episodes.find((e) => overlaps(e, segment))
    if (!hit) continue
    detected += 1
    const firstInside = Math.max(hit.start, segment.start)
    delays.push(firstInside - segment.start)
  }

  const truePositiveEpisodes = episodes.filter((e) => segments.some((s) => overlaps(e, s))).length
  const falsePositiveEpisodes = episodes.length - truePositiveEpisodes

  const recall = segments.length ? detected / segments.length : null
  const precision = episodes.length ? truePositiveEpisodes / episodes.length : null
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0

  return {
    segments: segments.length,
    detectedSegments: detected,
    episodes: episodes.length,
    falsePositiveEpisodes,
    precision,
    recall,
    f1,
    medianDelayWindows: median(delays),
    firingWindows: fired.filter(Boolean).length,
    totalWindows: fired.length,
  }
}

export function backtestMachine(dataset, { historyWindows = 120, paramOverrides = {} } = {}) {
  const params = smdParams(dataset.metrics, paramOverrides)
  const results = {}

  for (const [key, detector] of Object.entries(DETECTORS)) {
    const fired = rollingDetect(dataset.windows, {
      metrics: dataset.metrics,
      params,
      historyWindows,
      detector,
    })
    results[key] = scoreDetections(fired, dataset.labels)
  }

  return { machine: dataset.machine, windows: dataset.windows.length, results }
}
