import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WindowBuffer } from '../src/buffer.js'

test('keeps samples per service', () => {
  const buffer = new WindowBuffer(10)
  buffer.push('a', { v: 1 })
  buffer.push('b', { v: 2 })
  buffer.push('a', { v: 3 })
  assert.equal(buffer.size('a'), 2)
  assert.equal(buffer.size('b'), 1)
  assert.deepEqual(buffer.services().sort(), ['a', 'b'])
})

test('evicts the oldest sample beyond capacity', () => {
  const buffer = new WindowBuffer(3)
  for (let i = 1; i <= 5; i++) buffer.push('svc', { v: i })
  assert.equal(buffer.size('svc'), 3)
  assert.deepEqual(buffer.get('svc').map((s) => s.v), [3, 4, 5])
})

test('returns an empty array for an unknown service', () => {
  assert.deepEqual(new WindowBuffer(5).get('missing'), [])
})

test('rejects a nonsensical capacity', () => {
  assert.throws(() => new WindowBuffer(1), /capacity must be an integer >= 3/)
  assert.throws(() => new WindowBuffer(2.5), /capacity must be an integer >= 3/)
})

test('clears one service or all', () => {
  const buffer = new WindowBuffer(5)
  buffer.push('a', { v: 1 })
  buffer.push('b', { v: 1 })
  buffer.clear('a')
  assert.equal(buffer.size('a'), 0)
  assert.equal(buffer.size('b'), 1)
  buffer.clear()
  assert.equal(buffer.services().length, 0)
})
