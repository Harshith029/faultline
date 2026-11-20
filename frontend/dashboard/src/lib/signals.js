import { DEFAULT_PARAMS, metricDirection, metricMeta, metricThreshold, orientZ } from '@faultline/core'

/**
 * How the dashboard decides a metric looks bad, using the engine's own rules.
 *
 * Comparing a raw z-score against zThreshold misreads every metric whose
 * failure is a fall (direction 'down': throughput, cache hit rate) and every
 * metric with its own threshold. A chart that disagrees with the engine about
 * which signals qualified is worse than no chart, so these ask the engine's
 * question rather than a simpler one.
 */

const metricsOf = (params) => (params?.metrics?.length ? params.metrics : DEFAULT_PARAMS.metrics)

/** A window's z-score for a metric, flipped so that larger always means worse. */
export const evidenceZ = (window, metric, params = DEFAULT_PARAMS) =>
  orientZ(Number(window?.metrics?.[metricMeta(metric).zKey] ?? 0), metricDirection(metric, params))

/** Past the metric's own threshold, in its bad direction. */
export const isElevated = (window, metric, params = DEFAULT_PARAMS) =>
  evidenceZ(window, metric, params) >= metricThreshold(metric, params)

export const anyElevated = (window, params = DEFAULT_PARAMS) =>
  metricsOf(params).some((metric) => isElevated(window, metric, params))
