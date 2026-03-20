import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION })

export const handler = async (event) => {
  const serviceId = event.queryStringParameters?.service_id
  if (!serviceId) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'service_id required' })
    }
  }

  const result = await dynamo.send(new QueryCommand({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: 'service_id = :sid',
    ExpressionAttributeValues: { ':sid': { S: serviceId } },
    ExpressionAttributeNames: { '#m': 'metrics' },
    ProjectionExpression: 'service_id, window_timestamp, window_number, #m, ' +
      'qualified_signals, signal_count, R_score, confidence, triggered, outage, ' +
      'hypothesis, hypothesis_fallback',
    ScanIndexForward: true
  }))

  if (!result.Items || result.Items.length === 0) {
    return {
      statusCode: 404,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'no timeline data found for service_id: ' + serviceId })
    }
  }

  const windows = result.Items.map(unmarshall)
  windows.sort((a, b) => a.window_number - b.window_number)

  const triggeredIndex = windows.findIndex(w => w.triggered === true)
  if (triggeredIndex === -1) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id: serviceId, windows })
    }
  }

  const triggeredWindow = windows[triggeredIndex]
  console.log(JSON.stringify({
    event: 'DETECTION_TRIGGER',
    window: triggeredWindow.window_number,
    R_score: triggeredWindow.R_score
  }))

  const promptString = buildPrompt(triggeredWindow)
  const promptPayload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 300,
    temperature: 0.2,
    messages: [{ role: 'user', content: promptString }]
  }

  const bedrockCall = bedrock.send(new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: new TextEncoder().encode(JSON.stringify(promptPayload))
  }))

  let timerId
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('Bedrock timeout')), 2500)
  })

  try {
    const response = await Promise.race([bedrockCall, timeout])
    clearTimeout(timerId)

    const decoded = new TextDecoder().decode(response.body)
    const parsed = JSON.parse(decoded)
    const text = parsed?.content?.[0]?.text
    if (!text) throw new Error('invalid Bedrock response structure')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON block in Bedrock response')

    const generated = JSON.parse(jsonMatch[0])

    if (isValidHypothesis(generated)) {
      windows[triggeredIndex].hypothesis = generated
      console.log(JSON.stringify({
        event: 'BEDROCK_RESPONSE',
        status: 'hypothesis_generated',
        window: triggeredWindow.window_number
      }))
    } else {
      windows[triggeredIndex].hypothesis = triggeredWindow.hypothesis_fallback
      console.log(JSON.stringify({
        event: 'FALLBACK_ACTIVATED',
        reason: 'invalid_schema',
        window: triggeredWindow.window_number
      }))
    }
  } catch (err) {
    clearTimeout(timerId)
    windows[triggeredIndex].hypothesis = triggeredWindow.hypothesis_fallback
    console.log(JSON.stringify({
      event: 'FALLBACK_ACTIVATED',
      reason: err.message === 'Bedrock timeout' ? 'bedrock_timeout' : 'bedrock_error',
      window: triggeredWindow.window_number
    }))
  }

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ service_id: serviceId, windows })
  }
}

const isValidHypothesis = (h) =>
  h?.root_service &&
  h?.mechanism &&
  h?.cascade_path &&
  Array.isArray(h?.evidence) &&
  h.evidence.length === 3 &&
  h.evidence.every(e => typeof e === 'string' && e.length > 0)

const buildPrompt = (w) => `
You are a reliability engineer analyzing microservice drift signals.
Service ID: ${w.service_id}
Window: ${w.window_number}

Qualified signals:
${w.qualified_signals.map(s =>
  `- ${s.metric}: z=${s.z_score}, sustained ${s.windows_sustained} windows`
).join('\n')}

Metrics:
- p99_latency_z: ${w.metrics.p99_latency_z}
- retry_rate_z:  ${w.metrics.retry_rate_z}
- error_rate_z:  ${w.metrics.error_rate_z}

Identify the most likely root cause of this cascade failure.
Respond with ONLY this JSON object and nothing else:
{
  "root_service": "service ID of root cause",
  "mechanism": "one sentence explanation of failure mechanism",
  "cascade_path": "e.g. A → B → C (must use → symbol, not ->)",
  "evidence": ["evidence string 1", "evidence string 2", "evidence string 3"]
}
Do NOT include explanations, markdown, or any text outside the JSON object.
If you cannot determine a root cause, still return the JSON schema with your best hypothesis.
`