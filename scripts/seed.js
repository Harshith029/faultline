import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { marshall } from '@aws-sdk/util-dynamodb'

const s3 = new S3Client({ region: process.env.AWS_REGION })
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION })

const s3Res = await s3.send(new GetObjectCommand({
  Bucket: process.env.DATASET_BUCKET,
  Key: 'faultline_windows.json'
}))

const body = await s3Res.Body.transformToString()
const windows = JSON.parse(body)

let requests = windows.map(item => ({
  PutRequest: { Item: marshall(item) }
}))

do {
  const res = await dynamo.send(new BatchWriteItemCommand({
    RequestItems: { 'Faultline-DriftSignals': requests }
  }))
  requests = res.UnprocessedItems?.['Faultline-DriftSignals'] || []
} while (requests.length > 0)

console.log('All 12 windows seeded successfully')