import { describe, expect, it } from 'vitest'
import { runDetection } from '@faultline/core'
import { liveParamsFor, toPositionalWindows } from '../src/lib/liveTelemetry'

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

  it('declares one-minute spacing so the engine can see a missing minute', () => {
    expect(liveParamsFor({ ...liveResponse(), window_seconds: 60 }).windowSeconds).toBe(60)
    // An older API that does not send the field is still one-minute data.
    expect(liveParamsFor(liveResponse()).windowSeconds).toBe(60)
  })

  it('never lets a sustained run span a minute the API had no data for', () => {
    const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)
    const minute = (m) => new Date(T0 + m * 60_000).toISOString()
    const calm = { p99_latency: 200, client_error_rate: 1, error_rate: 0.5 }
    const hot = { p99_latency: 2000, client_error_rate: 40, error_rate: 30 }
    // Minutes 0-5 calm, 6 elevated, 7 missing, 8 elevated: the API numbers them
    // by slot, so the hole shows as a jump from 7 to 9.
    const raw = [
      ...[0, 1, 2, 3, 4, 5].map((m) => ({ window_number: m + 1, window_timestamp: minute(m), ...calm })),
      { window_number: 7, window_timestamp: minute(6), ...hot },
      { window_number: 9, window_timestamp: minute(8), ...hot },
    ]
    const data = { ...liveResponse(), window_seconds: 60, raw }

    const rows = toPositionalWindows(data.raw)
    expect(rows.map((w) => w.window_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows.at(-1).minute_slot).toBe(9)

    // Renumbered for display, the hole is still found from the timestamps.
    const last = runDetection(rows, liveParamsFor(data)).windows.at(-1)
    expect(last.gap_before).toBe(true)
    expect(last.triggered).toBe(false)
  })
})
