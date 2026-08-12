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
  const metrics = options.metrics ?? ctx.config?.detector?.metrics ?? [
    'p99_latency',
    'retry_rate',
    'error_rate',
  ]
  const mapping = {
    service: 'service',
    ...Object.fromEntries(metrics.map((m) => [m, m])),
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
        .map((row) => {
          const sample = { service: row[mapping.service], timestamp: row.timestamp ?? timestamp }
          for (const metric of metrics) {
            const value = row[mapping[metric]]
            // Absent or unparseable stays absent. The detector rejects the whole
            // sample and reports the gap; turning it into NaN-then-zero here
            // would invent a measurement the endpoint never returned.
            if (value === undefined || value === null || value === '') continue
            const numeric = Number(value)
            if (Number.isFinite(numeric)) sample[metric] = numeric
          }
          return sample
        })
        .filter((s) => s.service !== undefined && s.service !== null)

      if (samples.length === 0) logger?.warn('source.empty_response', { url: options.url })
      return samples
    },

    state() {
      return { url: options.url }
    },
  }
}
