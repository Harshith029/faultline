import { runDetection } from '@faultline/core'
import { WindowBuffer } from './buffer.js'

const DEFAULT_METRICS = ['p99_latency', 'retry_rate', 'error_rate']

/**
 * How far ahead of the agent's own clock a sample may be stamped. Beyond this
 * the timestamp cannot be trusted to order the series: accepting a sample from
 * two hours in the future would make every honest sample after it look out of
 * order until real time caught up.
 */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

// Events a misbehaving source can produce on every tick are logged on the first
// occurrence and then sparsely, so a bad exporter cannot turn into a log flood.
const shouldLog = (count) => count === 1 || count % 1000 === 0

/**
 * Runs the deterministic engine over a rolling window buffer, once per tick.
 *
 * Note on rolling baselines: the baseline is the oldest `baselineWindows`
 * entries of the buffer, so a very long-lived incident will eventually be
 * absorbed into its own baseline and stop registering as drift. Size
 * `historyWindows` for the longest incident you expect to alert on.
 *
 * The buffer is only meaningful as a series of distinct, ordered observations,
 * so a sample is placed relative to the newest one already buffered:
 *   - same source timestamp      → a replay of an observation already counted: dropped
 *   - older source timestamp     → a late arrival that would reorder history: dropped
 *   - more than maxSampleGapSeconds later → accepted, but the engine treats the
 *     hole as a break, so a sustained run cannot span it
 *   - later than the whole history span → everything buffered predates the
 *     history the buffer stands for: the service starts over and warms up again
 * Samples without a source timestamp are stamped on receipt; each collection is
 * then its own observation by definition, and only the gap rules apply.
 */
export class RollingDetector {
  constructor({
    params,
    resolveParams,
    historyWindows = 40,
    intervalSeconds = null,
    maxSampleGapSeconds = null,
    maxServices = Number.POSITIVE_INFINITY,
    logger,
  }) {
    this.params = params
    this.metrics = params.metrics?.length ? params.metrics : DEFAULT_METRICS
    // Per-service overrides; falls back to one shared profile when unconfigured.
    this.resolveParams = resolveParams ?? (() => ({ params, profile: null }))
    this.historyWindows = historyWindows
    this.logger = logger
    this.buffer = new WindowBuffer(historyWindows)
    this.detections = new Map()
    this.minWindows = params.baselineWindows + params.minSustain

    // Time spacing. Without a known collection interval a hole cannot be told
    // apart from normal spacing, so gap handling stays off (library use).
    this.intervalSeconds = Number(intervalSeconds) > 0 ? Number(intervalSeconds) : null
    // An explicit tolerance applies as given. Otherwise each service is judged
    // against 1.5 × its own observed spacing (see spacingSeconds).
    this.configuredMaxGapSeconds = Number(maxSampleGapSeconds) > 0 ? Number(maxSampleGapSeconds) : null

    // Every distinct service name costs a buffer, a cached profile and incident
    // state. The service name comes from telemetry, so a mislabelled exporter
    // could otherwise grow the agent without bound. Past the cap, new services
    // are refused and counted rather than silently evicting known ones.
    this.maxServices = maxServices
    this.tracked = new Set()
    this.servicesRejected = 0
    this.lastServiceRejection = null

    // Data-quality accounting. "The agent is running" and "the agent is seeing
    // valid telemetry" are different claims, and only these counters can tell
    // them apart.
    this.completeSamples = 0
    this.incompleteSamples = 0
    this.duplicateSamples = 0
    this.outOfOrderSamples = 0
    this.sampleGaps = 0
    this.historyResets = 0
    this.evaluationErrors = 0
    this.lastCompleteSampleAt = new Map()
    // When a service last sent anything at all, complete or not. Used only to
    // decide whether a service has disappeared, never for freshness.
    this.lastSeenAt = new Map()
    this.lastIncomplete = null
    this.lastContinuityEvent = null
    this.lastIngest = null
  }

  /** Per-service freshness, so a service that quietly stopped reporting is visible. */
  freshness(nowMs = Date.now()) {
    return this.buffer.services().map((service) => {
      const at = this.lastCompleteSampleAt.get(service)
      return {
        service,
        lastCompleteSampleAt: at ? new Date(at).toISOString() : null,
        // Whole seconds, rounded down: the same unit and rule as the agent's
        // global no-data check, so "stale" means one thing everywhere.
        staleSeconds: at ? Math.floor((nowMs - at) / 1000) : null,
      }
    })
  }

  dataQuality(nowMs = Date.now()) {
    const freshness = this.freshness(nowMs)
    const staleSeconds = freshness
      .map((f) => f.staleSeconds)
      .filter((s) => Number.isFinite(s))
    return {
      servicesTracked: this.tracked.size,
      maxServices: Number.isFinite(this.maxServices) ? this.maxServices : null,
      servicesRejected: this.servicesRejected,
      lastServiceRejection: this.lastServiceRejection,
      completeSamples: this.completeSamples,
      incompleteSamples: this.incompleteSamples,
      duplicateSamples: this.duplicateSamples,
      outOfOrderSamples: this.outOfOrderSamples,
      sampleGaps: this.sampleGaps,
      historyResets: this.historyResets,
      evaluationErrors: this.evaluationErrors,
      // null: the default rule, 1.5 × each service's observed spacing.
      gapToleranceSeconds: this.configuredMaxGapSeconds,
      lastIncomplete: this.lastIncomplete,
      lastContinuityEvent: this.lastContinuityEvent,
      lastIngest: this.lastIngest,
      oldestServiceStaleSeconds: staleSeconds.length ? Math.max(...staleSeconds) : null,
      freshness,
    }
  }

  /**
   * How far apart this service's observations really arrive: the median gap
   * between its buffered samples, and never less than the collection interval.
   *
   * A source with a new datapoint once a minute, polled every 15 s, is a
   * one-minute series: its replays are dropped as duplicates, and judging what
   * remains against 15 s would call every sample a gap, so no signal could
   * ever be sustained. The median is not moved by the occasional real hole.
   */
  spacingSeconds(service) {
    return this.spacingOf(this.buffer.get(service))?.seconds ?? null
  }

  /** `observed` is false until the series has shown any spacing of its own. */
  spacingOf(series) {
    if (this.intervalSeconds === null) return null
    const gaps = []
    for (let i = 1; i < series.length; i++) {
      const seconds = (Date.parse(series[i].timestamp) - Date.parse(series[i - 1].timestamp)) / 1000
      if (seconds > 0) gaps.push(seconds)
    }
    if (gaps.length === 0) return { seconds: this.intervalSeconds, observed: false }
    gaps.sort((a, b) => a - b)
    return { seconds: Math.max(this.intervalSeconds, gaps[Math.floor(gaps.length / 2)]), observed: true }
  }

  paramsFor(service) {
    const { params, profile } = this.resolveParams(service)
    const spacing = this.spacingSeconds(service)
    return {
      // The engine needs the series' spacing to recognise a hole in the
      // timestamps; per-service profiles cannot change it, so it is added here.
      params:
        spacing === null
          ? params
          : { ...params, windowSeconds: spacing, maxGapSeconds: this.configuredMaxGapSeconds },
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
   *
   * The timestamp is held to the same standard: one that cannot be parsed, or
   * that lies further in the future than MAX_FUTURE_SKEW_MS, cannot place the
   * sample in the series, so it counts as missing too.
   */
  normalizeSample(sample, metrics = this.metrics, nowMs = Date.now()) {
    const timestamp = sample.timestamp ?? new Date(nowMs).toISOString()
    const out = {
      service: String(sample.service),
      timestamp,
    }
    const missing = []

    const observedAtMs = Date.parse(timestamp)
    if (!Number.isFinite(observedAtMs) || observedAtMs > nowMs + MAX_FUTURE_SKEW_MS) missing.push('timestamp')

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

  /**
   * Where a valid sample sits relative to the newest one already buffered for
   * its service. `sourceStamped` is false when the agent stamped the sample on
   * receipt, in which case two collections can share a millisecond and still be
   * two observations.
   */
  placement(service, sample, sourceStamped) {
    const series = this.buffer.get(service)
    const previous = series[series.length - 1]
    if (!previous) return { kind: 'first' }

    const deltaMs = Date.parse(sample.timestamp) - Date.parse(previous.timestamp)
    if (!Number.isFinite(deltaMs)) return { kind: 'adjacent' }

    // Only two times the source reported can show a replay or a reordering. A
    // receipt stamp says when the agent asked, which is later than when the data
    // was observed, so comparing the two kinds would make an honest source
    // timestamp look like a late arrival.
    const comparable = sourceStamped && previous.sourceStamped === true
    if (comparable && deltaMs === 0) return { kind: 'duplicate', deltaMs }
    if (comparable && deltaMs < 0) return { kind: 'out_of_order', deltaMs }

    const spacing = this.spacingOf(series)
    if (spacing !== null) {
      // The buffer stands for historyWindows observations. After a hole longer
      // than that, everything in it predates the history it is meant to hold.
      if (deltaMs > this.historyWindows * spacing.seconds * 1000) return { kind: 'history_reset', deltaMs }
      // A hole can only be called once the series' own spacing is known; with a
      // single sample buffered, a coarse source's first interval is not one.
      const toleranceSeconds = this.configuredMaxGapSeconds ?? (spacing.observed ? spacing.seconds * 1.5 : null)
      if (toleranceSeconds !== null && deltaMs > toleranceSeconds * 1000) return { kind: 'gap', deltaMs }
    }
    return { kind: 'adjacent', deltaMs }
  }

  noteContinuity(kind, service, deltaMs, nowMs) {
    this.lastContinuityEvent = {
      kind,
      service,
      gapSeconds: Number.isFinite(deltaMs) ? Math.round(deltaMs / 1000) : null,
      at: new Date(nowMs).toISOString(),
    }
  }

  /** True if this service is, or may become, one the detector tracks. */
  admit(service, nowMs = Date.now()) {
    if (this.tracked.has(service)) return true
    if (this.tracked.size >= this.maxServices) {
      this.servicesRejected += 1
      this.lastServiceRejection = { service, at: new Date(nowMs).toISOString() }
      // Logged on the first refusal and then sparsely: a label explosion would
      // otherwise turn into a log explosion.
      if (shouldLog(this.servicesRejected)) {
        this.logger?.warn('service.capacity_exceeded', {
          service,
          maxServices: this.maxServices,
          rejected: this.servicesRejected,
          message: 'new service refused: detector.maxServices reached; check the service label for high cardinality',
        })
      }
      return false
    }
    this.tracked.add(service)
    return true
  }

  ingest(samples, { nowMs = Date.now() } = {}) {
    const results = []
    const seen = new Set()
    const rejected = []
    let dropped = 0

    for (const raw of samples ?? []) {
      if (raw?.service === undefined || raw.service === null) continue
      const service = String(raw.service)
      if (!this.admit(service, nowMs)) continue
      this.lastSeenAt.set(service, nowMs)
      const { metrics } = this.paramsFor(service)
      const { ok, sample, missing } = this.normalizeSample(raw, metrics, nowMs)

      if (!ok) {
        rejected.push({ service, missing })
        this.incompleteSamples += 1
        this.lastIncomplete = { service, missing, at: new Date(nowMs).toISOString() }
        this.logger?.warn('sample.incomplete', {
          service,
          missing,
          message: missing.includes('timestamp')
            ? 'sample dropped: its timestamp is unparseable or too far in the future to order the series'
            : 'sample dropped: missing metrics are not treated as zero',
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

      const sourceStamped = raw.timestamp !== undefined && raw.timestamp !== null
      const { kind, deltaMs } = this.placement(service, sample, sourceStamped)

      if (kind === 'duplicate') {
        // The source re-delivered an observation that is already counted. It is
        // not new data, so it neither enters the buffer nor refreshes freshness.
        this.duplicateSamples += 1
        dropped += 1
        this.noteContinuity(kind, service, deltaMs, nowMs)
        this.logger?.debug('sample.duplicate', { service, timestamp: sample.timestamp })
        continue
      }

      if (kind === 'out_of_order') {
        this.outOfOrderSamples += 1
        dropped += 1
        this.noteContinuity(kind, service, deltaMs, nowMs)
        if (shouldLog(this.outOfOrderSamples)) {
          this.logger?.warn('sample.out_of_order', {
            service,
            timestamp: sample.timestamp,
            behindSeconds: Math.round(-deltaMs / 1000),
            message: 'sample dropped: it is older than the newest observation already buffered for this service',
          })
        }
        continue
      }

      if (kind === 'history_reset') {
        this.buffer.clear(service)
        this.detections.delete(service)
        this.historyResets += 1
        this.noteContinuity(kind, service, deltaMs, nowMs)
        this.logger?.warn('service.history_reset', {
          service,
          gapSeconds: Math.round(deltaMs / 1000),
          message: 'no telemetry for longer than the whole history window; the baseline is rebuilt from fresh data',
        })
      } else if (kind === 'gap') {
        this.sampleGaps += 1
        this.noteContinuity(kind, service, deltaMs, nowMs)
        this.logger?.debug('sample.gap', { service, gapSeconds: Math.round(deltaMs / 1000) })
      }

      // Kept with the sample, and persisted with it, so a later sample is only
      // ever checked for replay against a time of the same kind.
      this.buffer.push(service, { ...sample, sourceStamped })
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
      dropped,
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

      // One service's bad data must never stop the others being evaluated: an
      // exception here would otherwise abort the whole tick for every service.
      let detection
      try {
        detection = runDetection(windows, params)
      } catch (err) {
        this.evaluationErrors += 1
        this.detections.delete(service)
        this.logger?.error('detector.evaluation_failed', { service, message: err.message })
        results.push({
          service,
          profile,
          status: 'evaluation_failed',
          error: err.message,
          windowsBuffered: series.length,
        })
        continue
      }
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
   * A restored sample is held to the same contract as a live one, under the
   * configuration the agent is running *now*: every metric present, a usable
   * observation time, and no earlier than the sample before it. A metric
   * added to the config since the snapshot was written would otherwise turn
   * every restored sample into an exception at the next evaluation.
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
  hydrateBuffers(entries = [], { nowMs = Date.now() } = {}) {
    let samples = 0
    let dropped = 0

    for (const entry of entries) {
      if (!entry?.service || !Array.isArray(entry.samples)) continue
      const service = String(entry.service)
      const { metrics } = this.paramsFor(service)

      const usable = []
      let newestMs = null
      for (const raw of entry.samples) {
        const normalized =
          raw && typeof raw === 'object' && raw.timestamp != null
            ? this.normalizeSample({ ...raw, service }, metrics, nowMs)
            : null
        const atMs = normalized?.ok ? Date.parse(normalized.sample.timestamp) : Number.NaN
        // Strictly older is out of order. Equal is kept: ingest never buffers a
        // replayed source timestamp, so two equal times in a saved buffer are
        // receipt stamps from collections that landed in the same millisecond.
        if (!normalized?.ok || (newestMs !== null && atMs < newestMs)) {
          dropped += 1
          continue
        }
        usable.push({ ...normalized.sample, sourceStamped: raw.sourceStamped === true })
        newestMs = atMs
      }

      // A service with nothing usable left is not restored at all, so it cannot
      // hold a capacity slot it will never fill.
      if (usable.length === 0 || !this.admit(service, nowMs)) continue
      for (const sample of usable) this.buffer.push(service, sample)
      samples += usable.length
      this.lastCompleteSampleAt.set(service, Math.min(newestMs, nowMs))
    }

    if (dropped > 0) {
      this.logger?.warn('state.restore_samples_dropped', {
        dropped,
        message: 'restored samples that do not meet the current metric configuration, or are out of order, were discarded',
      })
    }
    return { samples, dropped }
  }

  /**
   * Forgets a service entirely: its buffer, its latest detection, its freshness
   * and its capacity slot. Health and ranking stop considering it at once.
   */
  retire(service) {
    const known = this.tracked.has(service) || this.buffer.size(service) > 0
    this.buffer.clear(service)
    this.detections.delete(service)
    this.tracked.delete(service)
    this.lastCompleteSampleAt.delete(service)
    this.lastSeenAt.delete(service)
    return known
  }

  /**
   * Services that have sent nothing at all — not even an incomplete sample —
   * for longer than `seconds`. A service sending broken samples is still
   * present (and still reported as a data problem); only silence counts.
   */
  silentFor(seconds, nowMs = Date.now()) {
    const limitMs = seconds * 1000
    return [...this.tracked].filter((service) => {
      const lastHeardMs = this.lastSeenAt.get(service) ?? this.lastCompleteSampleAt.get(service)
      return lastHeardMs !== undefined && nowMs - lastHeardMs > limitMs
    })
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
