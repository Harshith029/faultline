import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, runDetection } from '@faultline/core'
import { anyElevated, evidenceZ, isElevated } from '../src/lib/signals'

const windowWith = ({ p99 = 0, retry = 0, error = 0 } = {}) => ({
  metrics: { p99_latency_z: p99, retry_rate_z: retry, error_rate_z: error },
})

describe('signal helpers', () => {
  it('treat a fall as the problem for a metric whose direction is down', () => {
    const params = { ...DEFAULT_PARAMS, direction: { p99_latency: 'down' } }
    const window = windowWith({ p99: -3 })

    expect(evidenceZ(window, 'p99_latency', params)).toBe(3)
    expect(isElevated(window, 'p99_latency', params)).toBe(true)
    // The naive reading — raw z against the threshold — calls it nominal.
    expect(isElevated(window, 'p99_latency', DEFAULT_PARAMS)).toBe(false)
  })

  it('use a per-metric threshold when one is configured', () => {
    const params = { ...DEFAULT_PARAMS, zThresholdPerMetric: { retry_rate: 4 } }
    const window = windowWith({ retry: 3 })

    expect(isElevated(window, 'retry_rate', params)).toBe(false)
    expect(isElevated(window, 'retry_rate', DEFAULT_PARAMS)).toBe(true)
  })

  it('agree with the engine about a falling metric that qualified', () => {
    const params = {
      ...DEFAULT_PARAMS,
      metrics: ['throughput', 'error_rate'],
      direction: { throughput: 'down' },
    }
    const calm = { throughput: 1000, error_rate: 0.5 }
    const failing = { throughput: 300, error_rate: 3 }
    const raw = [calm, calm, calm, calm, failing, failing].map((values, i) => ({ window_number: i + 1, ...values }))

    const last = runDetection(raw, params).windows.at(-1)

    expect(last.qualified_signals.map((s) => s.metric)).toContain('throughput_z')
    expect(isElevated(last, 'throughput', params)).toBe(true)
    expect(anyElevated(last, params)).toBe(true)
  })

  it('call a quiet window quiet', () => {
    expect(anyElevated(windowWith({ p99: 1, retry: -4, error: 0.5 }), DEFAULT_PARAMS)).toBe(false)
  })
})
