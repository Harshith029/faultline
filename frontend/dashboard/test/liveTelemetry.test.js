import { describe, expect, it } from 'vitest'
import { runDetection } from '@faultline/core'
import { liveParamsFor } from '../src/lib/liveTelemetry'

// Shaped exactly like the Lambda's `?source=live` response.
const liveResponse = () => ({
  metrics: ['p99_latency', 'client_error_rate', 'error_rate'],
  raw: Array.from({ length: 12 }, (_, i) => ({
    window_number: i + 1,
    p99_latency: 200 + (i > 6 ? (i - 6) * 400 : i % 2),
    client_error_rate: 1 + (i > 6 ? (i - 6) * 6 : 0),
    error_rate: 0.5 + (i > 6 ? (i - 6) * 4 : 0),
  })),
})

describe('live telemetry parameters', () => {
  it('scores the metrics the response declares, including client_error_rate', () => {
    const data = liveResponse()
    const result = runDetection(data.raw, liveParamsFor(data))

    expect(Object.keys(result.baselines)).toEqual(['p99_latency', 'client_error_rate', 'error_rate'])
    expect(result.windows.at(-1).metrics.client_error_rate_z).toBeGreaterThan(2)
    expect(result.detectionWindow).not.toBeNull()
  })

  it('keys the sigma floors by the metrics actually present', () => {
    expect(liveParamsFor(liveResponse()).sigmaFloorAbs).toEqual({ p99_latency: 100, client_error_rate: 2, error_rate: 2 })
  })

  it('refuses rows that lack a declared metric instead of scoring them as zero', () => {
    const data = liveResponse()
    delete data.raw[3].client_error_rate
    expect(() => runDetection(data.raw, liveParamsFor(data))).toThrow(/client_error_rate/)
  })
})
