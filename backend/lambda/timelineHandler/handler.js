import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const JSON_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

const LIVE_WINDOW_MINUTES = 60
// A single Query page is capped at 1 MB, so a long timeline arrives in pieces.
// Without following LastEvaluatedKey the tail is silently dropped, which looks
// exactly like an incident that never happened.
const MAX_QUERY_PAGES = 20

const round2 = (x) => Math.round(x * 100) / 100

const json = (statusCode, body) => ({
  statusCode,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
})

/**
 * Live CloudWatch telemetry for the configured API Gateway.
 *
 * Metric naming note: `client_error_rate` is API Gateway's 4XXError, which
 * counts every client-side error — auth failures, malformed requests, throttled
 * calls. It is NOT a retry counter. An earlier version of this handler labelled
 * it `retry_rate`, which asserted a causal story the metric cannot support.
 *
 * Missing datapoints stay missing. CloudWatch omits periods with no data, and
 * substituting zero would manufacture an observation — a latency of "0 ms" that
 * the detector would happily fold into its baseline.
 */
const liveTelemetry = async ({ cloudwatch, GetMetricData, env, now }) => {
  const apiName = env.LIVE_API_NAME || 'Faultline-API'
  const end = new Date(Math.floor(now() / 60000) * 60000)
  const start = new Date(end.getTime() - LIVE_WINDOW_MINUTES * 60000)
  const dimensions = [{ Name: 'ApiName', Value: apiName }]

  const metricQuery = (id, metricName, stat) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'AWS/ApiGateway', MetricName: metricName, Dimensions: dimensions },
      Period: 60,
      Stat: stat,
    },
  })

  const result = await cloudwatch.send(
    new GetMetricData({
      StartTime: start,
      EndTime: end,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: [
        metricQuery('latency', 'Latency', 'p99'),
        metricQuery('client_errors', '4XXError', 'Average'),
        metricQuery('server_errors', '5XXError', 'Average'),
      ],
    })
  )

  const series = {}
  for (const r of result.MetricDataResults ?? []) {
    const timestamps = r.Timestamps ?? []
    const values = r.Values ?? []
    series[r.Id] = new Map(
      timestamps
        .map((t, i) => [new Date(t).getTime(), values[i]])
        .filter(([, v]) => Number.isFinite(v))
    )
  }

  const raw = []
  const gaps = []
  for (let i = 0; i < LIVE_WINDOW_MINUTES; i++) {
    const t = start.getTime() + i * 60000
    const latency = series.latency?.get(t)
    const clientErrors = series.client_errors?.get(t)
    const serverErrors = series.server_errors?.get(t)

    const missing = []
    if (!Number.isFinite(latency)) missing.push('p99_latency')
    if (!Number.isFinite(clientErrors)) missing.push('client_error_rate')
    if (!Number.isFinite(serverErrors)) missing.push('error_rate')

    if (missing.length > 0) {
      gaps.push({ window_timestamp: new Date(t).toISOString(), missing })
      continue
    }

    raw.push({
      window_number: raw.length + 1,
      window_timestamp: new Date(t).toISOString(),
      p99_latency: round2(latency),
      client_error_rate: round2(clientErrors * 100),
      error_rate: round2(serverErrors * 100),
    })
  }

  return json(200, {
    service_id: 'live',
    source: 'cloudwatch',
    api_name: apiName,
    metrics: ['p99_latency', 'client_error_rate', 'error_rate'],
    metric_mapping: {
      p99_latency: 'API Gateway p99 latency (ms)',
      client_error_rate:
        '4XX client-error rate (%). All client-side errors, including auth failures and malformed requests. Not a retry count.',
      error_rate: '5XX server-error rate (%)',
    },
    data_quality: {
      windows_requested: LIVE_WINDOW_MINUTES,
      windows_complete: raw.length,
      windows_incomplete: gaps.length,
      // Gaps are reported, never filled. A caller that wants to interpolate can
      // do so knowingly; the API will not do it silently.
      gaps: gaps.slice(0, 10),
    },
    raw,
  })
}

/** Follows LastEvaluatedKey so a timeline longer than one page is not truncated. */
const queryAllWindows = async ({ dynamo, Query, tableName, serviceId }) => {
  const items = []
  let exclusiveStartKey
  let pages = 0

  do {
    const page = await dynamo.send(
      new Query({
        TableName: tableName,
        KeyConditionExpression: 'service_id = :sid',
        ExpressionAttributeValues: { ':sid': { S: serviceId } },
        ExpressionAttributeNames: { '#m': 'metrics' },
        ProjectionExpression:
          'service_id, window_timestamp, window_number, #m, ' +
          'qualified_signals, signal_count, R_score, confidence, triggered, outage, ' +
          'hypothesis, hypothesis_fallback',
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    )
    items.push(...(page.Items ?? []))
    exclusiveStartKey = page.LastEvaluatedKey
    pages += 1
  } while (exclusiveStartKey && pages < MAX_QUERY_PAGES)

  return { items, pages, truncated: Boolean(exclusiveStartKey) }
}

/**
 * A hypothesis is only usable if every field it asserts is present AND its
 * evidence actually refers to signals the detector qualified. A model that
 * invents a fourth signal, cites a metric that never fired, or implies a path
 * beyond this one service is discarded in favour of the deterministic fallback.
 */
export const isValidHypothesis = (h, window) => {
  if (!h || typeof h !== 'object') return false
  if (typeof h.root_service !== 'string' || h.root_service.trim() === '') return false
  if (typeof h.mechanism !== 'string' || h.mechanism.trim() === '') return false
  if (typeof h.cascade_path !== 'string' || h.cascade_path.trim() === '') return false
  if (!Array.isArray(h.evidence) || h.evidence.length !== 3) return false
  if (!h.evidence.every((e) => typeof e === 'string' && e.trim() !== '')) return false

  // The model may only name the service the detector actually evaluated. It has
  // no topology, so any other "root service" is a fabrication.
  if (window?.service_id && h.root_service.trim() !== String(window.service_id)) return false
  if (window?.service_id && h.cascade_path.trim() !== String(window.service_id)) return false

  // The prompt alone cannot make model output grounded. Each evidence line has
  // to name at least one metric that genuinely qualified in the triggering
  // window; otherwise an invented but plausible-sounding explanation would
  // reach the dashboard as if it were observed evidence.
  const qualifiedMetrics = (window?.qualified_signals ?? [])
    .map((signal) => String(signal?.metric ?? '').trim())
    .filter(Boolean)
  if (qualifiedMetrics.length === 0) return false
  if (
    !h.evidence.every((entry) => {
      const text = entry.toLowerCase()
      return qualifiedMetrics.some((metric) => text.includes(metric.toLowerCase()))
    })
  ) {
    return false
  }

  return true
}

const buildPrompt = (w) => {
  const signals = (w.qualified_signals ?? [])
    .map((s) => `- ${s.metric}: z=${s.z_score}, sustained ${s.windows_sustained} windows`)
    .join('\n')

  const metricLines = Object.entries(w.metrics ?? {})
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')

  return `You are a reliability engineer summarising a drift detection for one service.

Service ID: ${w.service_id}
Window: ${w.window_number}

Qualified signals (the only signals the detector confirmed):
${signals || '- none'}

Metric z-scores for this window:
${metricLines || '- none'}

IMPORTANT CONSTRAINTS:
- You are given signals for ONE service only. There is no dependency graph, no
  traces, and no deploy history in this input.
- Do not name any service other than "${w.service_id}".
- Do not claim a downstream or upstream effect you cannot see in the data above.
- Every evidence string must cite one of the qualified signals listed above.

Respond with ONLY this JSON object and nothing else:
{
  "root_service": "${w.service_id}",
  "mechanism": "one sentence describing what the drift in these metrics is consistent with, hedged appropriately",
  "cascade_path": "${w.service_id}",
  "evidence": ["cite qualified signal 1", "cite qualified signal 2", "cite qualified signal 3"]
}
Do NOT include explanations, markdown, or any text outside the JSON object.`
}

const explainWithBedrock = async ({ bedrock, InvokeModel, env, window, timeoutMs = 2500 }) => {
  const promptPayload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 300,
    temperature: 0.2,
    messages: [{ role: 'user', content: buildPrompt(window) }],
  }

  const call = bedrock.send(
    new InvokeModel({
      modelId: env.BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(promptPayload)),
    })
  )

  let timerId
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('Bedrock timeout')), timeoutMs)
  })

  try {
    const response = await Promise.race([call, timeout])
    const decoded = new TextDecoder().decode(response.body)
    const parsed = JSON.parse(decoded)
    const text = parsed?.content?.[0]?.text
    if (!text) throw new Error('invalid Bedrock response structure')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON block in Bedrock response')

    const generated = JSON.parse(jsonMatch[0])
    if (!isValidHypothesis(generated, window)) {
      return { ok: false, reason: 'invalid_schema' }
    }
    return {
      ok: true,
      hypothesis: {
        ...generated,
        generated_by: 'bedrock',
        model_id: env.BEDROCK_MODEL_ID ?? null,
        // The explanation describes signals from exactly one service. Say so in
        // the payload so no consumer can present it as cross-service causality.
        scope: 'single_service_drift',
        evidence_source: 'qualified_signals',
      },
    }
  } catch (err) {
    return { ok: false, reason: err.message === 'Bedrock timeout' ? 'bedrock_timeout' : 'bedrock_error' }
  } finally {
    clearTimeout(timerId)
  }
}

/**
 * Builds the Lambda handler around injectable AWS clients.
 *
 * Tests supply fakes; production supplies real SDK clients. Nothing about the
 * request logic changes between the two, which is what makes the mocked tests
 * meaningful.
 */
export function createHandler({
  dynamo,
  bedrock,
  cloudwatch,
  commands = {},
  env = process.env,
  now = Date.now,
  log = (entry) => console.log(JSON.stringify(entry)),
} = {}) {
  const Query = commands.QueryCommand ?? QueryCommand
  const InvokeModel = commands.InvokeModelCommand ?? InvokeModelCommand
  const GetMetricData = commands.GetMetricDataCommand ?? GetMetricDataCommand

  return async (event = {}) => {
    const params = event.queryStringParameters ?? {}

    if (params.source === 'live') {
      try {
        return await liveTelemetry({ cloudwatch, GetMetricData, env, now })
      } catch (err) {
        log({ event: 'LIVE_TELEMETRY_ERROR', message: err.message })
        return json(502, { error: 'live telemetry unavailable' })
      }
    }

    const serviceId = params.service_id
    if (!serviceId || !/^[A-Za-z0-9_-]{1,64}$/.test(serviceId)) {
      return json(400, {
        error: 'service_id required: 1-64 alphanumeric, dash, or underscore characters',
      })
    }

    let queryResult
    try {
      queryResult = await queryAllWindows({
        dynamo,
        Query,
        tableName: env.TABLE_NAME,
        serviceId,
      })
    } catch (err) {
      log({ event: 'TIMELINE_QUERY_ERROR', message: err.message })
      return json(502, { error: 'timeline unavailable' })
    }

    if (queryResult.items.length === 0) {
      return json(404, { error: 'no timeline data found for service_id: ' + serviceId })
    }

    if (queryResult.truncated) {
      log({ event: 'TIMELINE_TRUNCATED', service_id: serviceId, pages: queryResult.pages })
    }

    const windows = queryResult.items.map(unmarshall)
    windows.sort((a, b) => a.window_number - b.window_number)

    const meta = {
      pages_fetched: queryResult.pages,
      truncated: queryResult.truncated,
      window_count: windows.length,
    }

    const triggeredIndex = windows.findIndex((w) => w.triggered === true)
    if (triggeredIndex === -1) {
      return json(200, { service_id: serviceId, windows, meta })
    }

    const triggeredWindow = windows[triggeredIndex]
    log({
      event: 'DETECTION_TRIGGER',
      window: triggeredWindow.window_number,
      R_score: triggeredWindow.R_score,
    })

    if (!env.BEDROCK_MODEL_ID || !bedrock) {
      windows[triggeredIndex].hypothesis = triggeredWindow.hypothesis_fallback
      log({ event: 'FALLBACK_ACTIVATED', reason: 'bedrock_not_configured', window: triggeredWindow.window_number })
      return json(200, { service_id: serviceId, windows, meta })
    }

    const outcome = await explainWithBedrock({
      bedrock,
      InvokeModel,
      env,
      window: triggeredWindow,
    })

    if (outcome.ok) {
      windows[triggeredIndex].hypothesis = outcome.hypothesis
      log({
        event: 'BEDROCK_RESPONSE',
        status: 'hypothesis_generated',
        window: triggeredWindow.window_number,
      })
    } else {
      windows[triggeredIndex].hypothesis = triggeredWindow.hypothesis_fallback
      log({ event: 'FALLBACK_ACTIVATED', reason: outcome.reason, window: triggeredWindow.window_number })
    }

    return json(200, { service_id: serviceId, windows, meta })
  }
}

// Lazily constructed so importing this module never requires AWS credentials.
let defaultHandler = null

export const handler = async (event) => {
  if (!defaultHandler) {
    const region = process.env.AWS_REGION
    defaultHandler = createHandler({
      dynamo: new DynamoDBClient({ region }),
      bedrock: new BedrockRuntimeClient({ region }),
      cloudwatch: new CloudWatchClient({ region }),
    })
  }
  return defaultHandler(event)
}

export { buildPrompt, queryAllWindows, liveTelemetry }
