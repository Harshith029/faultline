const DEFAULT_QUERIES = {
  p99_latency:
    'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[1m])) by (le, service)) * 1000',
  retry_rate:
    'sum(rate(http_client_retries_total[1m])) by (service) / clamp_min(sum(rate(http_requests_total[1m])) by (service), 1) * 100',
  error_rate:
    'sum(rate(http_requests_total{status=~"5.."}[1m])) by (service) / clamp_min(sum(rate(http_requests_total[1m])) by (service), 1) * 100',
}

/**
 * Reads instant vectors from a Prometheus-compatible API (Prometheus, Thanos,
 * Mimir, VictoriaMetrics). Each query must return one series per service,
 * labelled by `serviceLabel`.
 */
export function createPrometheusSource(options = {}, ctx = {}) {
  const baseUrl = (options.url ?? 'http://localhost:9090').replace(/\/+$/, '')
  const queries = { ...DEFAULT_QUERIES, ...(options.queries ?? {}) }
  const serviceLabel = options.serviceLabel ?? 'service'
  const timeoutMs = options.timeoutMs ?? 10000
  const headers = options.headers ?? {}
  const logger = ctx.logger

  const query = async (promql) => {
    const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(promql)}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`Prometheus query failed (${res.status}) for: ${promql}`)
    const body = await res.json()
    if (body.status !== 'success') {
      throw new Error(`Prometheus returned status=${body.status}: ${body.error ?? 'unknown error'}`)
    }
    if (body.data?.resultType !== 'vector') {
      throw new Error(`Expected an instant vector, got resultType=${body.data?.resultType}`)
    }
    return body.data.result ?? []
  }

  return {
    name: 'prometheus',

    async collect() {
      const timestamp = new Date().toISOString()
      const byService = new Map()

      for (const [metric, promql] of Object.entries(queries)) {
        let result
        try {
          result = await query(promql)
        } catch (err) {
          logger?.error('source.query_failed', { metric, message: err.message })
          throw err
        }

        for (const series of result) {
          const service = series.metric?.[serviceLabel]
          if (!service) continue
          const value = Number(series.value?.[1])
          if (!Number.isFinite(value)) continue
          if (!byService.has(service)) byService.set(service, { service, timestamp })
          byService.get(service)[metric] = value
        }
      }

      return [...byService.values()]
    },

    state() {
      return { url: baseUrl, metrics: Object.keys(queries), serviceLabel }
    },
  }
}
