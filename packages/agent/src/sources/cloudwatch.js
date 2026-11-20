/**
 * API Gateway's 4XXError counts every client-side error — auth failures,
 * malformed requests, throttling. It is not a retry counter, and calling it
 * `retry_rate` asserted a client-behaviour story the metric cannot support.
 * If you have a real retry counter, map it explicitly via `options.metrics`.
 */
import { configuredMetrics } from './metrics.js'

const DEFAULT_METRICS = {
  p99_latency: { metricName: 'Latency', stat: 'p99' },
  client_error_rate: { metricName: '4XXError', stat: 'Average', scale: 100 },
  error_rate: { metricName: '5XXError', stat: 'Average', scale: 100 },
}

/** How many whole periods each collection reads back. */
const WINDOW_PERIODS = 3

/**
 * Regroups the response from one series per metric into one row per period:
 * service -> Map(period time in ms -> { metric: value }).
 *
 * A datapoint whose value is not a finite number, or whose time cannot be
 * read, is left out. It cannot be placed in a period, and leaving it absent
 * keeps "not observed" from turning into zero: a fabricated 0 ms latency would
 * be indistinguishable from a genuinely idle service.
 */
function groupByPeriod(results, idMap) {
  const byService = new Map()
  for (const result of results) {
    const meta = idMap.get(result.Id)
    if (!meta) continue
    if (!byService.has(meta.service)) byService.set(meta.service, new Map())
    const periods = byService.get(meta.service)
    // CloudWatch documents Timestamps[i] as the time of Values[i].
    const values = result.Values ?? []
    const timestamps = result.Timestamps ?? []
    for (let i = 0; i < values.length; i++) {
      const at = new Date(timestamps[i] ?? Number.NaN).getTime()
      if (!Number.isFinite(values[i]) || !Number.isFinite(at)) continue
      periods.set(at, { ...periods.get(at), [meta.metric]: values[i] * meta.scale })
    }
  }
  return byService
}

/**
 * Builds one service's sample from a single CloudWatch period.
 *
 * CloudWatch publishes each metric on its own schedule, so the newest latency
 * datapoint can be a period ahead of the newest 4XX count. Taking each metric's
 * newest value would build a sample no single period produced, and one
 * datapoint could land in two consecutive samples with different times: one
 * bad minute showing up as two elevated windows. The sample therefore takes
 * every value from the newest period in which every required metric has a
 * datapoint, and carries that period's time.
 *
 * Required means configured: the metrics the detector uses, including any a
 * per-service rule adds. A service whose own rule needs fewer can be held a
 * period back by a metric it ignores, but is never given values from two periods.
 *
 * When no period in the window has them all, the newest period is used as it
 * is. Its missing metrics stay missing, so a service that needs one of them
 * gets an incomplete sample instead of values that were never observed together.
 */
function sampleFromPeriods(service, periods, requiredMetrics, receivedAt) {
  const newestFirst = [...periods.keys()].sort((a, b) => b - a)
  // Own keys only: `in` would also find inherited names such as `constructor`.
  const isComplete = (at) => requiredMetrics.every((metric) => Object.hasOwn(periods.get(at), metric))
  const at = newestFirst.find(isComplete) ?? newestFirst[0]
  // No datapoint at all: nothing CloudWatch observed can date the sample, so it
  // carries the receipt time. It has no metrics either, so the detector rejects
  // it as incomplete and that time never counts towards freshness.
  if (at === undefined) return { service, timestamp: receivedAt }
  return { service, timestamp: new Date(at).toISOString(), ...periods.get(at) }
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
  const wanted = configuredMetrics(ctx.config)
  if (wanted) {
    const unsupplied = wanted.filter((m) => !(m in metrics))
    if (unsupplied.length > 0) {
      throw new Error(
        `cloudwatch source cannot supply configured metrics [${unsupplied.join(', ')}]. ` +
          `It emits [${Object.keys(metrics).join(', ')}]. ` +
          'Either set detector.metrics to match, or map the missing metrics via source.options.metrics.'
      )
    }
  }

  // A sample is complete when it has every configured metric, because that is
  // what the detector will require of it. A source built without agent config
  // requires everything it collects.
  const requiredMetrics = wanted ?? Object.keys(metrics)

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
      // The window is aligned to whole periods, as AWS recommends, so every
      // poll asks for the same period boundaries. A period read on two polls
      // comes back under the same time both times, and the detector drops the
      // second read as a duplicate instead of counting one period twice.
      // EndTime is exclusive, so the period still in progress is never read
      // half-filled.
      const periodMs = periodSeconds * 1000
      const end = new Date(Math.floor(Date.now() / periodMs) * periodMs)
      const start = new Date(end.getTime() - periodMs * WINDOW_PERIODS)

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

      // Freshness must describe when CloudWatch observed the data, not when the
      // agent happened to ask for it, so a sample carries its period's time.
      const receivedAt = new Date().toISOString()
      const samples = []
      for (const [service, periods] of groupByPeriod(response.MetricDataResults ?? [], idMap)) {
        samples.push(sampleFromPeriods(service, periods, requiredMetrics, receivedAt))
      }

      logger?.debug('source.cloudwatch_collected', { services: samples.length })
      return samples
    },

    state() {
      return { region, namespace, targets: targets.map((t) => t.service) }
    },
  }
}
