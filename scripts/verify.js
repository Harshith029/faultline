import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION })

const result = await dynamo.send(new QueryCommand({
  TableName: 'Faultline-DriftSignals',
  KeyConditionExpression: 'service_id = :sid',
  ExpressionAttributeValues: { ':sid': { S: 'B' } },
  Select: 'ALL_ATTRIBUTES',
  ConsistentRead: true,
  ScanIndexForward: true
}))

const windows = (result.Items || []).map(item => unmarshall(item))
windows.sort((a, b) => a.window_number - b.window_number)

let pass = true

if (windows.length !== 12) {
  console.error('FAIL: Expected 12 records, got ' + windows.length)
  pass = false
} else {
  console.log('PASS: Count = 12')
}

const w8 = windows.find(w => w.window_number === 8)
if (!w8 || w8.triggered !== true) {
  console.error('FAIL: W8 triggered is not true')
  pass = false
} else {
  console.log('PASS: W8 triggered = true')
}

const w12 = windows.find(w => w.window_number === 12)
if (!w12 || w12.outage !== true) {
  console.error('FAIL: W12 outage is not true')
  pass = false
} else {
  console.log('PASS: W12 outage = true')
}

if (pass) {
  console.log('\nALL ASSERTIONS PASSED — dataset is ready')
} else {
  console.error('\nVERIFICATION FAILED — re-run seed.js')
  process.exit(1)
}