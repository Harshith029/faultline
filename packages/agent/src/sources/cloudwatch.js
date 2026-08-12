/**
 * API Gateway's 4XXError counts every client-side error — auth failures,
 * malformed requests, throttling. It is not a retry counter, and calling it
 * `retry_rate` asserted a client-behaviour story the metric cannot support.
 * If you have a real retry counter, map it explicitly via `options.metrics`.
 */
const DEFAULT_METRICS = {
  p99_latency: { metricName: 'Latency', stat: 'p99' },
  client_error_rate: { metricName: '4XXError', stat: 'Average', scale: 100 },
  error_rate: { metricName: '5XXError', stat: 'Average', scale: 100 },
}

/**
 * Amazon CloudWatch source. The AWS SDK is imported lazily and declared as an
 * optional peer, so the agent keeps zero required runtime dependencies for
 * everyone not running on AWS.
 */
export function createCloudWatchSource(options = {}, ctx = {}) {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1'
  const namespace = options.namespace ?? 'AWS/ApiGateway'
  const periodSeconds = options.periodSeconds ?? 60
  const metrics = { ...DEFAULT_METRICS, ...(options.metrics ?? {}) }
  const targets = options.targets ?? []
  const logger = ctx.logger

  if (targets.length === 0) {
    throw new Error(
      'cloudwatch source requires "targets": [{ "service": "checkout-api", "dimensions": { "ApiName": "my-api" } }]'
    )
  }

  // Under the complete-sample contract a metric this source never emits makes
  // every sample incomplete, so the agent would collect forever and detect
  // nothing. That is a configuration error; say so at startup rather than
  // running blind.
  // A service rule can narrow or replace the global metric list. Check those
  // effective possibilities too: validating only detector.metrics lets a
  // custom per-service metric pass startup and then reject every sample for
  // that service indefinitely.
  const wanted = new Set(ctx.config?.detector?.metrics ?? [])
  for (const rule of ctx.config?.services ?? []) {
    if (!Array.isArray(rule?.metrics)) continue
    for (const metric of rule.metrics) wanted.add(metric)
  }
  if (wanted.size > 0) {
    const unsupplied = [...wanted].filter((m) => !(m in metrics))
    if (unsupplied.length > 0) {
      throw new Error(
        `cloudwatch source cannot supply configured metrics [${unsupplied.join(', ')}]. ` +
          `It emits [${Object.keys(metrics).join(', ')}]. ` +
          'Either set detector.metrics to match, or map the missing metrics via source.options.metrics.'
      )
    }
  }

  // Tests (and anyone wrapping the SDK) can supply a client directly; production
  // resolves it lazily so the agent keeps zero required runtime dependencies.
  //
  // The promise is memoised rather than the resolved client: two overlapping
  // collections would otherwise both miss the cache and each construct their
  // own client.
  let clientPromise = options.client ? Promise.resolve(options.client) : null

  const getClient = () => {
    if (clientPromise) return clientPromise

    clientPromise = (async () => {
      let sdk
      try {
        sdk = await import('@aws-sdk/client-cloudwatch')
      } catch {
        throw new Error(
          'The cloudwatch source needs the AWS SDK. Install it with:  npm install @aws-sdk/client-cloudwatch'
        )
      }
      return {
        cw: new sdk.CloudWatchClient({ region }),
        GetMetricDataCommand: sdk.GetMetricDataCommand,
      }
    })().catch((err) => {
      // A failed import must not be cached, or the fix (installing the SDK)
      // could never take effect without a restart.
      clientPromise = null
      throw err
    })

    return clientPromise
  }

  return {
    name: 'cloudwatch',

    async collect() {
      const { cw, GetMetricDataCommand } = await getClient()
      const end = new Date(Math.floor(Date.now() / 1000) * 1000)
      const start = new Date(end.getTime() - periodSeconds * 3 * 1000)

      const queries = []
      const idMap = new Map()
      targets.forEach((target, ti) => {
        Object.entries(metrics).forEach(([metric, spec], mi) => {
          const id = `m${ti}_${mi}`
          idMap.set(id, { service: target.service, metric, scale: spec.scale ?? 1 })
          queries.push({
            Id: id,
            MetricStat: {
              Metric: {
                Namespace: target.namespace ?? namespace,
                MetricName: spec.metricName,
                Dimensions: Object.entries(target.dimensions ?? {}).map(([Name, Value]) => ({
                  Name,
                  Value: String(Value),
                })),
              },
              Period: periodSeconds,
              Stat: spec.stat,
            },
          })
        })
      })

      const response = await cw.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          ScanBy: 'TimestampDescending',
          MetricDataQueries: queries,
        })
      )

      const timestamp = new Date().toISOString()
      const byService = new Map()
      for (const result of response.MetricDataResults ?? []) {
        const meta = idMap.get(result.Id)
        if (!meta) continue
        if (!byService.has(meta.service)) {
          byService.set(meta.service, { service: meta.service, timestamp })
        }
        // Most recent datapoint; CloudWatch can lag a period behind. A period
        // with no datapoint is left absent rather than set to zero — CloudWatch
        // omitting a value means "not observed", and a fabricated 0 ms latency
        // would be indistinguishable from a genuinely idle service.
        const value = result.Values?.[0]
        if (Number.isFinite(value)) {
          byService.get(meta.service)[meta.metric] = value * meta.scale
        }
      }

      logger?.debug('source.cloudwatch_collected', { services: byService.size })
      return [...byService.values()]
    },

    state() {
      return { region, namespace, targets: targets.map((t) => t.service) }
    },
  }
}
