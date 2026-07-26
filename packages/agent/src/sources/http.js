/**
 * Generic pull source: any endpoint that returns the current telemetry sample
 * for each service. Accepts either a bare array or `{ samples: [...] }`.
 *
 *   [{ "service": "checkout-api", "p99_latency": 128, "retry_rate": 0.6, "error_rate": 0.3 }]
 *
 * `mapping` renames incoming fields, so an existing internal metrics endpoint
 * can usually be adapted without writing any code.
 */
export function createHttpSource(options = {}, ctx = {}) {
  if (!options.url) throw new Error('http source requires "url"')
  const timeoutMs = options.timeoutMs ?? 10000
  const headers = options.headers ?? {}
  const mapping = {
    service: 'service',
    p99_latency: 'p99_latency',
    retry_rate: 'retry_rate',
    error_rate: 'error_rate',
    ...(options.mapping ?? {}),
  }
  const logger = ctx.logger

  return {
    name: 'http',

    async collect() {
      const res = await fetch(options.url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`telemetry endpoint responded ${res.status}`)
      const body = await res.json()
      const rows = Array.isArray(body) ? body : body?.samples

      if (!Array.isArray(rows)) {
        throw new Error('telemetry endpoint must return an array or { samples: [...] }')
      }

      const timestamp = new Date().toISOString()
      const samples = rows
        .map((row) => ({
          service: row[mapping.service],
          timestamp: row.timestamp ?? timestamp,
          p99_latency: Number(row[mapping.p99_latency]),
          retry_rate: Number(row[mapping.retry_rate]),
          error_rate: Number(row[mapping.error_rate]),
        }))
        .filter((s) => s.service !== undefined && s.service !== null)

      if (samples.length === 0) logger?.warn('source.empty_response', { url: options.url })
      return samples
    },

    state() {
      return { url: options.url }
    },
  }
}
