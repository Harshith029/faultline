import { DEFAULT_PARAMS } from '@faultline/core'

// Absolute sigma floors for live API Gateway telemetry. A quiet API's baseline
// is nearly flat, and a relative floor alone would turn a 1 ms wobble into a
// 10σ "drift".
const LIVE_SIGMA_FLOORS = { p99_latency: 100, client_error_rate: 2, error_rate: 2 }

/**
 * Detection parameters for a live telemetry response.
 *
 * Live telemetry names its own metrics (the API sends `client_error_rate`, not
 * `retry_rate`). Scoring it under the default metric list would read a field
 * that does not exist — which the engine refuses rather than scoring as zero.
 */
export function liveParamsFor(response) {
  const metrics =
    Array.isArray(response?.metrics) && response.metrics.length > 0 ? response.metrics : DEFAULT_PARAMS.metrics
  return {
    ...DEFAULT_PARAMS,
    metrics,
    sigmaFloorAbs: Object.fromEntries(
      metrics.filter((m) => m in LIVE_SIGMA_FLOORS).map((m) => [m, LIVE_SIGMA_FLOORS[m]])
    ),
  }
}
