import { runDetection } from '@faultline/core'
import { WindowBuffer } from './buffer.js'

const DEFAULT_METRICS = ['p99_latency', 'retry_rate', 'error_rate']

/**
 * Runs the deterministic engine over a rolling window buffer, once per tick.
 *
 * Note on rolling baselines: the baseline is the oldest `baselineWindows`
 * entries of the buffer, so a very long-lived incident will eventually be
 * absorbed into its own baseline and stop registering as drift. Size
 * `historyWindows` for the longest incident you expect to alert on.
 */
export class RollingDetector {
  constructor({ params, resolveParams, historyWindows = 40, logger }) {
    this.params = params
    this.metrics = params.metrics?.length ? params.metrics : DEFAULT_METRICS
    // Per-service overrides; falls back to one shared profile when unconfigured.
    this.resolveParams = resolveParams ?? (() => ({ params, profile: null }))
    this.historyWindows = historyWindows
    this.logger = logger
    this.buffer = new WindowBuffer(historyWindows)
    this.detections = new Map()
    this.minWindows = params.baselineWindows + params.minSustain
  }

  paramsFor(service) {
    const { params, profile } = this.resolveParams(service)
    return {
      params,
      profile,
      metrics: params.metrics?.length ? params.metrics : DEFAULT_METRICS,
      minWindows: params.baselineWindows + params.minSustain,
    }
  }

  normalizeSample(sample, metrics = this.metrics) {
    const out = {
      service: String(sample.service),
      timestamp: sample.timestamp ?? new Date().toISOString(),
    }
    for (const metric of metrics) {
      const value = Number(sample[metric])
      out[metric] = Number.isFinite(value) ? value : 0
    }
    return out
  }

  ingest(samples, { nowMs = Date.now() } = {}) {
    const results = []
    const seen = new Set()

    for (const raw of samples ?? []) {
      if (raw?.service === undefined || raw.service === null) continue
      const { metrics } = this.paramsFor(String(raw.service))
      const sample = this.normalizeSample(raw, metrics)
      this.buffer.push(sample.service, sample)
      seen.add(sample.service)
    }

    for (const service of seen) {
      const series = this.buffer.get(service)
      const { params, profile, metrics, minWindows } = this.paramsFor(service)

      if (series.length < minWindows) {
        results.push({
          service,
          profile,
          status: 'warming_up',
          windowsBuffered: series.length,
          windowsRequired: minWindows,
        })
        continue
      }

      const windows = series.map((sample, i) => {
        const window = {
          service_id: service,
          window_number: i + 1,
          window_timestamp: sample.timestamp,
        }
        for (const metric of metrics) window[metric] = sample[metric]
        return window
      })

      const detection = runDetection(windows, params)
      this.detections.set(service, { detection, updatedAt: new Date(nowMs).toISOString() })

      const latest = detection.windows[detection.windows.length - 1]
      results.push({
        service,
        profile,
        status: 'evaluated',
        windowsBuffered: series.length,
        evaluation: {
          timestamp: latest.window_timestamp,
          triggered: latest.triggered,
          R_score: latest.R_score,
          confidence: latest.confidence,
          signal_count: latest.signal_count,
          qualified_signals: latest.qualified_signals,
          metrics: latest.metrics,
          raw: latest.raw,
        },
        baselines: detection.baselines,
      })
    }

    return results
  }

  exportBuffers() {
    return this.buffer.services().map((service) => ({ service, samples: this.buffer.get(service) }))
  }

  hydrateBuffers(entries = []) {
    let restored = 0
    for (const entry of entries) {
      if (!entry?.service || !Array.isArray(entry.samples)) continue
      for (const sample of entry.samples) {
        if (sample && typeof sample === 'object') {
          this.buffer.push(entry.service, sample)
          restored += 1
        }
      }
    }
    return restored
  }

  windowsFor(service) {
    return this.detections.get(service)?.detection.windows ?? []
  }

  detectionFor(service) {
    return this.detections.get(service)?.detection ?? null
  }

  services() {
    return this.buffer.services()
  }
}
