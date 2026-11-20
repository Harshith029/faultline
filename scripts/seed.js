import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { marshall } from '@aws-sdk/util-dynamodb'

// Must match the stack's TableName parameter (template.yaml), which defaults to
// the same value.
const TABLE_NAME = process.env.TABLE_NAME || 'Faultline-DriftSignals'
// DynamoDB rejects a BatchWriteItem with more than 25 requests outright.
const BATCH_SIZE = 25
const MAX_ATTEMPTS = 8

if (!process.env.DATASET_BUCKET) {
  console.error('DATASET_BUCKET is required: the S3 bucket holding faultline_windows.json')
  process.exit(1)
}

const s3 = new S3Client({ region: process.env.AWS_REGION })
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const s3Res = await s3.send(new GetObjectCommand({
  Bucket: process.env.DATASET_BUCKET,
  Key: 'faultline_windows.json'
}))

const body = await s3Res.Body.transformToString()
const windows = JSON.parse(body)

const requests = windows.map(item => ({
  PutRequest: { Item: marshall(item) }
}))

for (let start = 0; start < requests.length; start += BATCH_SIZE) {
  let pending = requests.slice(start, start + BATCH_SIZE)

  // Throttled writes come back as UnprocessedItems rather than an error.
  // Retrying them immediately just gets throttled again, so back off, and give
  // up loudly instead of spinning forever.
  for (let attempt = 1; pending.length > 0; attempt++) {
    if (attempt > MAX_ATTEMPTS) {
      throw new Error(`${pending.length} item(s) still unprocessed after ${MAX_ATTEMPTS} attempts`)
    }
    if (attempt > 1) await sleep(Math.min(100 * 2 ** attempt, 5000))
    const res = await dynamo.send(new BatchWriteItemCommand({
      RequestItems: { [TABLE_NAME]: pending }
    }))
    pending = res.UnprocessedItems?.[TABLE_NAME] ?? []
  }
}

console.log(`All ${windows.length} windows seeded into ${TABLE_NAME}`)
