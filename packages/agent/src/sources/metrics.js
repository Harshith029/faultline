/**
 * Every metric the agent could need from a source: the global detector metrics
 * plus any metric a per-service rule introduces.
 *
 * Sources use this both to decide what to fetch and to refuse to start when they
 * cannot supply something. Under the complete-sample contract a metric that is
 * never supplied makes every sample for that service incomplete, so the agent
 * would collect forever and detect nothing — a configuration error that should
 * fail at startup, not hide behind a healthy-looking process.
 *
 * Returns null when there is no agent config (a source built on its own).
 */
export function configuredMetrics(config) {
  if (!config?.detector) return null
  const wanted = new Set(config.detector.metrics ?? [])
  for (const rule of config.services ?? []) {
    if (!Array.isArray(rule?.metrics)) continue
    for (const metric of rule.metrics) wanted.add(metric)
  }
  return wanted.size > 0 ? [...wanted] : null
}
