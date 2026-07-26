const DEFAULT_METRICS = {
  p99_latency: { metricName: 'Latency', stat: 'p99' },
  retry_rate: { metricName: '4XXError', stat: 'Average', scale: 100 },
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

  let client = null

  const getClient = async () => {
    if (client) return client
    let sdk
    try {
      sdk = await import('@aws-sdk/client-cloudwatch')
    } catch {
      throw new Error(
        'The cloudwatch source needs the AWS SDK. Install it with:  npm install @aws-sdk/client-cloudwatch'
      )
    }
    client = {
      cw: new sdk.CloudWatchClient({ region }),
      GetMetricDataCommand: sdk.GetMetricDataCommand,
    }
    return client
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
          byService.set(meta.service, {
            service: meta.service,
            timestamp,
            p99_latency: 0,
            retry_rate: 0,
            error_rate: 0,
          })
        }
        // Most recent non-empty datapoint; CloudWatch can lag a period behind.
        const value = result.Values?.[0]
        byService.get(meta.service)[meta.metric] = Number.isFinite(value) ? value * meta.scale : 0
      }

      logger?.debug('source.cloudwatch_collected', { services: byService.size })
      return [...byService.values()]
    },

    state() {
      return { region, namespace, targets: targets.map((t) => t.service) }
    },
  }
}
