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

    // Data-quality accounting. "The agent is running" and "the agent is seeing
    // valid telemetry" are different claims, and only these counters can tell
    // them apart.
    this.completeSamples = 0
    this.incompleteSamples = 0
    this.lastCompleteSampleAt = new Map()
    this.lastIncomplete = null
    this.lastIngest = null
  }

  /** Per-service freshness, so a service that quietly stopped reporting is visible. */
  freshness(nowMs = Date.now()) {
    return this.buffer.services().map((service) => {
      const at = this.lastCompleteSampleAt.get(service)
      return {
        service,
        lastCompleteSampleAt: at ? new Date(at).toISOString() : null,
        staleSeconds: at ? Math.round((nowMs - at) / 1000) : null,
      }
    })
  }

  dataQuality(nowMs = Date.now()) {
    const freshness = this.freshness(nowMs)
    const staleSeconds = freshness
      .map((f) => f.staleSeconds)
      .filter((s) => Number.isFinite(s))
    return {
      completeSamples: this.completeSamples,
      incompleteSamples: this.incompleteSamples,
      lastIncomplete: this.lastIncomplete,
      lastIngest: this.lastIngest,
      oldestServiceStaleSeconds: staleSeconds.length ? Math.max(...staleSeconds) : null,
      freshness,
    }
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

  /**
   * Validates one sample against the complete-sample contract.
   *
   * A metric that is absent, null, or non-numeric is *missing*, and missing is
   * not zero. Coercing it to zero manufactures an observation: a scrape that
   * lost its error-rate series would report a perfectly healthy 0% error rate,
   * quietly suppress a multi-signal incident, and drag the rolling baseline
   * toward a value nothing ever measured. The sample is rejected instead, and
   * the gap is reported.
   */
  normalizeSample(sample, metrics = this.metrics) {
    const timestamp = sample.timestamp ?? new Date().toISOString()
    const out = {
      service: String(sample.service),
      timestamp,
    }
    const missing = []

    if (!Number.isFinite(Date.parse(timestamp))) missing.push('timestamp')

    for (const metric of metrics) {
      const value = sample[metric]
      if (value === undefined || value === null || value === '') {
        missing.push(metric)
        continue
      }
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) {
        missing.push(metric)
        continue
      }
      out[metric] = numeric
    }

    return missing.length > 0 ? { ok: false, missing, sample: null } : { ok: true, missing, sample: out }
  }

  ingest(samples, { nowMs = Date.now() } = {}) {
    const results = []
    const seen = new Set()
    const rejected = []

    for (const raw of samples ?? []) {
      if (raw?.service === undefined || raw.service === null) continue
      const service = String(raw.service)
      const { metrics } = this.paramsFor(service)
      const { ok, sample, missing } = this.normalizeSample(raw, metrics)

      if (!ok) {
        rejected.push({ service, missing })
        this.incompleteSamples += 1
        this.lastIncomplete = { service, missing, at: new Date(nowMs).toISOString() }
        this.logger?.warn('sample.incomplete', {
          service,
          missing,
          message: 'sample dropped: missing metrics are not treated as zero',
        })
        results.push({
          service,
          profile: this.paramsFor(service).profile,
          status: 'incomplete_sample',
          missing,
          windowsBuffered: this.buffer.size(service),
        })
        continue
      }

      this.buffer.push(service, sample)
      // Freshness describes when the source observed the telemetry, not when
      // the agent happened to receive it. A replaying exporter can otherwise
      // deliver an hour-old sample every minute and keep /health green forever.
      // Future timestamps are capped at receipt time so clock skew cannot keep
      // a service looking fresh into the future.
      const observedAtMs = Date.parse(sample.timestamp)
      this.lastCompleteSampleAt.set(service, Math.min(observedAtMs, nowMs))
      this.completeSamples += 1
      seen.add(service)
    }

    this.lastIngest = {
      at: new Date(nowMs).toISOString(),
      received: samples?.length ?? 0,
      accepted: seen.size,
      rejected: rejected.length,
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

  /**
   * Restores buffers from disk, carrying each service's last-observed time with
   * them.
   *
   * Seeding `lastCompleteSampleAt` matters for freshness, not for detection: a
   * service restored from state and then never seen again would otherwise have
   * no recorded observation time at all, so the per-service staleness check
   * would skip it forever. The agent would look healthy on the strength of the
   * services that *did* resume — which is the same "telemetry loss looks like
   * good news" failure the complete-sample contract exists to prevent, just
   * scoped to one service across a restart.
   *
   * The time used is the sample's own timestamp, so a restored service starts
   * out as stale as its data genuinely is, and is refreshed by its next real
   * sample one tick later.
   */
  hydrateBuffers(entries = []) {
    let restored = 0
    for (const entry of entries) {
      if (!entry?.service || !Array.isArray(entry.samples)) continue

      let newestMs = null
      for (const sample of entry.samples) {
        if (!sample || typeof sample !== 'object') continue
        this.buffer.push(entry.service, sample)
        restored += 1

        const at = Date.parse(sample.timestamp)
        if (Number.isFinite(at) && (newestMs === null || at > newestMs)) newestMs = at
      }

      if (newestMs !== null) this.lastCompleteSampleAt.set(entry.service, newestMs)
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
