import { detectorParams } from './config.js'
import { compileServiceRules, createParamsResolver } from './serviceConfig.js'
import { SilenceManager } from './silences.js'
import { createLogger } from './logger.js'
import { createSource } from './sources/index.js'
import { RollingDetector } from './detector.js'
import { AlertManager } from './alerts.js'
import { createNotifiers } from './notifiers/index.js'
import { Store } from './store.js'
import { createApiServer } from './server.js'
import { createAuthenticator, isLoopbackHost } from './auth.js'

export const VERSION = '1.0.0'

// How many notifications a tick sends at once. A webhook that times out costs
// seconds; sending one incident's alert after another made a burst of N
// incidents cost N timeouts. Bounded rather than unbounded so a large burst
// does not hammer a rate-limited receiver (Slack accepts about one per second).
export const DELIVERY_CONCURRENCY = 4

// A collection that has been in flight this many intervals (and at least the
// minimum below) is treated as wedged, and liveness fails so the process can
// be restarted. Sources and notifiers all carry their own timeouts, so a tick
// that runs this long is stuck, not slow.
const LIVENESS_STALL_INTERVALS = 5
const LIVENESS_STALL_MIN_SECONDS = 60

// How long a retirement request waits for a collection in flight. A wedged
// collection is exactly what /livez reports; the request must not hang on it.
const RETIRE_WAIT_MS = 10_000
const MAX_RECENT_RETIREMENTS = 20

/** The agent cannot act on a request right now; retrying shortly may succeed. */
export class AgentBusyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AgentBusyError'
    this.code = 'AGENT_BUSY'
  }
}

// Resolves true if `promise` settles within `ms`, false otherwise.
const settlesWithin = (promise, ms) => {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Refuses to start an unauthenticated API on anything but loopback.
 *
 * The API creates silences and injects faults. Binding it to 0.0.0.0 with no
 * token hands anyone who can reach the port the ability to suppress alerting
 * fleet-wide. The previous behaviour logged a warning and served the request
 * anyway, which is indistinguishable from having no protection at all: warnings
 * do not stop requests. Failing to start is the only response that does.
 */
export function assertSafeExposure(serverConfig, env = process.env) {
  const auth = createAuthenticator(serverConfig, env)
  if (auth.enabled || isLoopbackHost(serverConfig.host)) return

  const tokenEnv = serverConfig.auth?.tokenEnv ?? 'FAULTLINE_API_TOKEN'
  throw new Error(
    `Refusing to start: the API would bind to ${serverConfig.host} with no authentication token, ` +
      'exposing POST /api/silences and POST /api/inject to anyone who can reach the port. ' +
      `Set ${tokenEnv} to a secret, or bind to 127.0.0.1 (FAULTLINE_HOST=127.0.0.1). ` +
      'If you genuinely want an open read-only API behind your own proxy, set a token and ' +
      'server.auth.allowAnonymousRead = true.'
  )
}

export class FaultlineAgent {
  constructor(config, { logger, env = process.env } = {}) {
    this.config = config
    this.logger = logger ?? createLogger(config.logging)
    this.env = env
    this.name = config.agent.name
    this.intervalSeconds = config.detector.intervalSeconds

    const ctx = { logger: this.logger, config }
    this.source = createSource(config.source, ctx)
    this.serviceRules = compileServiceRules(config.services)
    this.detector = new RollingDetector({
      params: detectorParams(config),
      resolveParams: createParamsResolver(detectorParams(config), this.serviceRules),
      historyWindows: config.detector.historyWindows,
      intervalSeconds: config.detector.intervalSeconds,
      maxSampleGapSeconds: config.detector.maxSampleGapSeconds ?? null,
      maxServices: config.detector.maxServices,
      logger: this.logger,
    })
    this.alerts = new AlertManager(config.alerting)
    this.notifiers = createNotifiers(config.alerting.notifiers, ctx)
    this.silences = new SilenceManager({ configSilences: config.silences, logger: this.logger })
    this.store = new Store({ ...config.storage, logger: this.logger })

    this.server = null
    this.timer = null
    this.running = false
    this.ticking = false
    // Set for the lifetime of shutdown; also the idempotency guard for stop().
    this.stopping = null
    // Resolves the moment stop() is called, so a start() awaiting a wedged
    // first collection can give up instead of hanging on it forever.
    this.stopRequested = new Promise((resolve) => {
      this.signalStopRequested = resolve
    })
    this.tickDone = null
    this.tickStartedAtMs = null
    this.lastTickCompletedAtMs = null
    this.ticks = 0
    this.collectErrors = 0
    this.consecutiveCollectErrors = 0
    this.lastCollectAt = null
    this.startedAtMs = null
    this.latest = new Map()
    // By reason, because the two mean different things: an operator retiring a
    // decommissioned service is housekeeping, while a silent retirement also
    // removed that service's stale-telemetry alarm and is worth alerting on.
    this.retiredServices = { operator: 0, silent: 0 }
    this.recentRetirements = []
    this.retireWaitMs = RETIRE_WAIT_MS

    // A successful HTTP call that returns nothing is not the same as telemetry.
    // These track "did we actually observe anything" independently of "did the
    // collection call succeed".
    this.emptyCollections = 0
    this.consecutiveEmptyCollections = 0
    this.lastDataAtMs = null
    this.noDataGraceSeconds = config.detector.noDataGraceSeconds
    this.retireAfterSeconds = config.detector.retireAfterSeconds ?? null
  }

  /**
   * Telemetry readiness: is the agent observing trustworthy telemetry? Served
   * at /health. It distinguishes three things a single boolean would conflate:
   * the process is alive, collection is succeeding, and the data is usable.
   *
   * An exporter rename or a permissions regression produces a perfectly
   * successful collection that observes nothing. Reporting that as `ok` is what
   * makes telemetry loss look like good news, so it degrades once the grace
   * period has passed.
   *
   * Staleness is counted in whole seconds, rounded down, and is degraded only
   * once it exceeds the grace period: the same rule the per-service check uses,
   * and one that does not flip on which millisecond a probe happens to land in.
   *
   * None of this belongs in a liveness probe — see liveness().
   */
  health(nowMs = Date.now()) {
    const reasons = []

    if (!this.running) reasons.push('agent_stopped')
    if (this.consecutiveCollectErrors >= 3) reasons.push('collection_failing')

    const graceMs = this.noDataGraceSeconds * 1000
    // Measured from the last observation, or from startup if there has never
    // been one, so a source that is broken from the first tick still degrades.
    const sinceDataMs = nowMs - (this.lastDataAtMs ?? this.startedAtMs ?? nowMs)
    const secondsSinceData = Math.floor(sinceDataMs / 1000)
    const noDataTooLong = this.startedAtMs !== null && secondsSinceData > this.noDataGraceSeconds
    if (noDataTooLong) {
      reasons.push(this.lastDataAtMs === null ? 'no_telemetry_since_start' : 'telemetry_stale')
    }

    // A collection can still contain valid samples while one previously seen
    // service has vanished. Global freshness alone would call that healthy and
    // hide the partial outage. Once a service has supplied a complete sample,
    // it is an expected telemetry target until it returns or is retired.
    const staleServices = this.detector
      .freshness(nowMs)
      .filter((entry) => Number.isFinite(entry.staleSeconds) && entry.staleSeconds > this.noDataGraceSeconds)
      .map((entry) => entry.service)
    if (staleServices.length > 0) reasons.push('service_telemetry_stale')

    // Services refused at the cap are services nobody is watching. Recent
    // refusals degrade health; an old, one-off burst does not keep it red.
    const rejection = this.detector.lastServiceRejection
    if (rejection && nowMs - Date.parse(rejection.at) <= graceMs) reasons.push('service_capacity_exceeded')

    return {
      status: reasons.length === 0 ? 'ok' : 'degraded',
      reasons,
      secondsSinceData: this.startedAtMs === null ? null : secondsSinceData,
      noDataGraceSeconds: this.noDataGraceSeconds,
      lastDataAt: this.lastDataAtMs ? new Date(this.lastDataAtMs).toISOString() : null,
      staleServices,
    }
  }

  /**
   * Process liveness: is the agent running and is its collection loop still
   * making progress? Served at /livez.
   *
   * Deliberately blind to telemetry. Restarting the agent cannot bring back an
   * exporter that is down or a service that was decommissioned, so wiring those
   * into a liveness probe only turns a telemetry problem into a restart loop.
   * A collection stuck on a socket is different: the loop has stopped, and a
   * restart is exactly the cure.
   */
  liveness(nowMs = Date.now()) {
    const reasons = []
    if (!this.running) reasons.push('agent_stopped')

    const stallSeconds = Math.max(LIVENESS_STALL_INTERVALS * this.intervalSeconds, LIVENESS_STALL_MIN_SECONDS)
    const tickInFlightSeconds =
      this.ticking && this.tickStartedAtMs !== null ? Math.floor((nowMs - this.tickStartedAtMs) / 1000) : null
    if (tickInFlightSeconds !== null && tickInFlightSeconds > stallSeconds) reasons.push('collection_stalled')

    return {
      status: reasons.length === 0 ? 'ok' : 'failing',
      reasons,
      tickInFlightSeconds,
      stallSeconds,
      lastTickCompletedAt: this.lastTickCompletedAtMs ? new Date(this.lastTickCompletedAtMs).toISOString() : null,
    }
  }

  /**
   * Restores the rolling buffers and incident lifecycle from disk.
   *
   * Without this, every restart costs a full warm-up — twelve minutes blind at
   * default settings, during which a rolling deploy of the agent itself leaves
   * nothing watching — and an incident in flight would re-open and page twice.
   *
   * The guard is staleness: telemetry from an hour ago describes a system that
   * may no longer exist, so old state is discarded and the agent warms up
   * honestly rather than scoring against a baseline it should not trust.
   */
  restoreDetectionState(nowMs = Date.now()) {
    const maxAgeMs = (this.config.storage.restoreMaxAgeSeconds ?? 0) * 1000
    if (maxAgeMs === 0) return { restored: false, reason: 'disabled' }

    const state = this.store.detectionState
    if (!state?.savedAt) return { restored: false, reason: 'no_saved_state' }

    const savedAtMs = Date.parse(state.savedAt)
    if (!Number.isFinite(savedAtMs)) return { restored: false, reason: 'unreadable_timestamp' }

    const ageSeconds = Math.round((nowMs - savedAtMs) / 1000)
    if (nowMs - savedAtMs > maxAgeMs) return { restored: false, reason: 'stale', ageSeconds }

    const buffers = this.detector.hydrateBuffers(state.buffers, { nowMs })
    return {
      restored: true,
      ageSeconds,
      samples: buffers.samples,
      // Samples that no longer satisfy the current metric configuration, or
      // were out of order, are discarded rather than scored.
      samplesDropped: buffers.dropped,
      services: this.alerts.hydrate(state.alerts),
    }
  }

  snapshotDetectionState() {
    this.store.detectionState = {
      savedAt: new Date().toISOString(),
      buffers: this.detector.exportBuffers(),
      alerts: this.alerts.exportState(),
    }
    this.store.markDirty()
  }

  /** Mirrors runtime silences into the durable store. */
  syncSilences() {
    this.silences.prune()
    this.store.silences = this.silences.persistable()
    this.store.markDirty()
  }

  /**
   * Stops tracking a service: its buffer, detection state, freshness and
   * ranking entry are dropped, so a decommissioned service no longer holds
   * /health degraded. Returns null if the agent did not know the service.
   *
   * An open incident is closed as `retired`, not `resolved`, and no
   * notification is sent: nothing was observed to recover, and FAULTLINE never
   * reports a recovery it did not see.
   *
   * Synchronous, so it must only run between ticks or inside one; the API goes
   * through retireService(), which waits for an in-flight tick first.
   */
  retireServiceNow(service, { reason = 'operator', nowMs = Date.now(), snapshot = true } = {}) {
    const known = this.detector.retire(service)
    const hadResult = this.latest.delete(service)
    const incident = this.alerts.retire(service, nowMs)
    if (!known && !hadResult && !incident) return null

    if (incident) {
      this.store.upsertIncident(incident)
      this.logger.warn('incident.retired', {
        incident: incident.id,
        service,
        reason,
        message: 'service retired while its incident was open; closed without a resolve notification',
      })
    }
    this.retiredServices = { ...this.retiredServices, [reason]: (this.retiredServices[reason] ?? 0) + 1 }
    this.recentRetirements = [
      { service, reason, at: new Date(nowMs).toISOString(), incidentClosed: incident?.id ?? null },
      ...this.recentRetirements,
    ].slice(0, MAX_RECENT_RETIREMENTS)
    this.logger.info('service.retired', { service, reason, incidentClosed: incident?.id ?? null })
    // Saved straight away, so a crash before the next periodic snapshot cannot
    // restore the service it was just told to forget.
    if (snapshot) this.snapshotDetectionState()
    return { service, reason, incidentClosed: incident?.id ?? null }
  }

  /**
   * Retires a service on request, once any collection in flight has finished.
   * Bounded: if the collection is wedged — the case /livez reports — this
   * gives up after `waitMs` with an AgentBusyError instead of hanging with it.
   */
  async retireService(service, { waitMs = this.retireWaitMs, ...options } = {}) {
    const deadline = Date.now() + waitMs
    while (this.ticking && this.tickDone) {
      const remaining = deadline - Date.now()
      if (remaining <= 0 || !(await settlesWithin(this.tickDone, remaining))) {
        throw new AgentBusyError('a collection is still in progress; retry once it has finished')
      }
    }
    return this.retireServiceNow(service, options)
  }

  /**
   * Retires services that have sent nothing for `detector.retireAfterSeconds`.
   * Off unless configured. A service with an open incident is never retired
   * automatically: one that is firing and then goes silent is exactly the one a
   * human needs to look at.
   */
  retireSilentServices(nowMs = Date.now()) {
    if (!this.retireAfterSeconds) return []
    const retired = []
    for (const service of this.detector.silentFor(this.retireAfterSeconds, nowMs)) {
      if (this.alerts.isFiring(service)) continue
      const outcome = this.retireServiceNow(service, { reason: 'silent', nowMs, snapshot: false })
      if (outcome) retired.push(outcome)
    }
    if (retired.length > 0) this.snapshotDetectionState()
    return retired
  }

  /**
   * Sends an alert unless the service is silenced or the incident is held.
   *
   * `notifiedAt` is what makes a maintenance window safe: an incident that
   * opens while silenced (or inside the post-resolution cooldown) is recorded
   * but not sent, and if it is still firing once the window ends it is
   * announced then rather than being lost.
   *
   * `notifiedAt` means *every* sink accepted the open. `deliveredTo` lists the
   * sinks that did, so a webhook that is down is retried on the next window
   * without re-paging the channels that already have it. A resolve goes only to
   * the sinks that received the open.
   */
  async maybeNotify(type, incident, nowMs = Date.now()) {
    const silence = this.silences.matching(incident.service)
    if (silence) {
      incident.silencedBy = silence.id
      this.logger.info('incident.silenced', {
        incident: incident.id,
        service: incident.service,
        silence: silence.id,
        reason: silence.reason ?? null,
      })
      return false
    }

    if (type === 'incident.opened' && incident.heldUntil && nowMs < Date.parse(incident.heldUntil)) {
      this.logger.info('incident.held', {
        incident: incident.id,
        service: incident.service,
        reason: 'cooldown',
        until: incident.heldUntil,
      })
      return false
    }

    const event = { type, agent: this.name, incident }

    if (type === 'incident.resolved') {
      const only = incident.deliveredTo?.length ? incident.deliveredTo : null
      await this.notifiers.notify(event, only ? { only } : {})
      return true
    }

    const report = await this.notifiers.notify(event, { skip: incident.deliveredTo ?? [] })
    // These can only be set after the await. Two notifications for one incident
    // cannot interleave: ticks are serialised by the `ticking` guard, a tick
    // handles each service once, and a service has at most one incident.
    incident.deliveredTo = [...(incident.deliveredTo ?? []), ...(report?.delivered ?? [])]
    const failed = report?.failed ?? []
    if (failed.length > 0) {
      this.logger.warn('incident.delivery_incomplete', {
        incident: incident.id,
        service: incident.service,
        failed,
        message: 'not every notifier accepted the alert; the failed ones are retried next window while it fires',
      })
      return false
    }
    incident.notifiedAt = new Date(nowMs).toISOString()
    return true
  }

  /**
   * Sends a tick's notifications, DELIVERY_CONCURRENCY at a time.
   *
   * The tick still waits for all of them: an incident's delivery state has to
   * be settled before the next tick decides whether to retry it. What changes is
   * the cost of a slow receiver — a burst of N incidents now costs roughly
   * ceil(N / DELIVERY_CONCURRENCY) notifier timeouts instead of N.
   */
  async deliver(jobs) {
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const { type, incident } = jobs[next++]
        try {
          await this.maybeNotify(type, incident)
        } catch (err) {
          // Notifiers report failures rather than throw, so this is a bug; it
          // must still not abandon the other incidents' deliveries.
          this.logger.error('notify.delivery_error', { incident: incident.id, message: err.message })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(DELIVERY_CONCURRENCY, jobs.length) }, worker))
  }

  async start() {
    await this.store.load()
    this.silences.hydrate(this.store.silences)
    this.syncSilences()
    this.stateRestore = this.restoreDetectionState()
    if (this.stateRestore.restored) {
      this.logger.info('state.restored', {
        ageSeconds: this.stateRestore.ageSeconds,
        services: this.stateRestore.services,
        samples: this.stateRestore.samples,
        samplesDropped: this.stateRestore.samplesDropped,
      })
    } else {
      this.logger.info('state.warming_up', { reason: this.stateRestore.reason })
    }
    this.running = true
    this.startedAtMs = Date.now()

    if (this.config.server.enabled) {
      assertSafeExposure(this.config.server, this.env)
      this.server = createApiServer(this, { logger: this.logger, serverConfig: this.config.server, env: this.env })
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.config.server.port, this.config.server.host, resolve)
      })
      const { address, port } = this.server.address()
      const scheme = this.server.faultlineTls ? 'https' : 'http'
      const auth = this.server.faultlineAuth
      this.logger.info('server.listening', {
        url: `${scheme}://${address}:${port}`,
        tls: this.server.faultlineTls,
        auth: auth.enabled ? (auth.allowAnonymousRead ? 'writes-only' : 'required') : 'disabled',
      })

      if (!auth.enabled) {
        this.logger.warn('server.unauthenticated', {
          message:
            'API has no token. This is only permitted because it is bound to loopback; anyone with local access may create silences and suppress alerting.',
          host: this.config.server.host,
        })
      }
      if (!this.server.faultlineTls && !isLoopbackHost(this.config.server.host)) {
        this.logger.warn('server.plaintext', {
          message: 'API is bound beyond localhost without TLS; tokens would cross the network in clear text.',
          host: this.config.server.host,
        })
      }
    }

    this.logger.info('agent.started', {
      agent: this.name,
      version: VERSION,
      source: this.source.name,
      intervalSeconds: this.intervalSeconds,
      notifiers: this.notifiers.types,
      historyWindows: this.config.detector.historyWindows,
      triggerThreshold: this.config.detector.triggerThreshold,
    })

    // The first collection is awaited so a caller can rely on one tick having
    // happened once start() resolves. It is raced against shutdown because a
    // wedged source would otherwise leave this promise pending forever, even
    // after stop() abandoned the tick — hanging any embedder that awaits
    // start(), and leaving the process with an unsettled promise.
    await Promise.race([this.tick(), this.stopRequested])

    if (this.stopping) return this

    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error('agent.tick_failed', { message: err.message }))
    }, this.intervalSeconds * 1000)
    this.timer.unref?.()

    return this
  }

  async tick() {
    // Once shutdown has begun, a tick that was already scheduled must not run.
    // Otherwise it advances state after the final snapshot was taken and that
    // work is lost, or worse, written after the store closed.
    //
    // `stopping` is set for the rest of the process lifetime, so this also
    // blocks ticks after shutdown completes. It deliberately does not test
    // `running`: the `once` command ticks a never-started agent on purpose.
    if (this.stopping) {
      this.logger.debug('agent.tick_skipped', { reason: 'agent is stopping' })
      return
    }
    // A slow source must never let two collection cycles overlap.
    if (this.ticking) {
      this.logger.warn('agent.tick_skipped', { reason: 'previous tick still running' })
      return
    }
    this.ticking = true
    this.tickStartedAtMs = Date.now()
    let settle
    this.tickDone = new Promise((resolve) => {
      settle = resolve
    })

    try {
      let samples
      try {
        samples = await this.source.collect()
        this.consecutiveCollectErrors = 0
      } catch (err) {
        this.collectErrors += 1
        this.consecutiveCollectErrors += 1
        this.logger.error('agent.collect_failed', {
          source: this.source.name,
          message: err.message,
          consecutive: this.consecutiveCollectErrors,
        })
        return
      }

      this.lastCollectAt = new Date().toISOString()
      this.ticks += 1

      // An empty array is a successful call that observed nothing. It must not
      // look like a healthy tick, and it must not reset the no-data clock.
      if (!Array.isArray(samples) || samples.length === 0) {
        this.emptyCollections += 1
        this.consecutiveEmptyCollections += 1
        this.logger.warn('agent.collect_empty', {
          source: this.source.name,
          consecutive: this.consecutiveEmptyCollections,
          message: 'collection succeeded but returned no samples; telemetry is not being observed',
        })
      } else {
        this.consecutiveEmptyCollections = 0
      }

      // Samples without a source timestamp are stamped with the start of this
      // collection cycle, not the moment they were parsed: consecutive cycles
      // are then exactly one interval apart, however long collection took.
      const results = this.detector.ingest(samples, { nowMs: this.tickStartedAtMs })

      // Only a sample that satisfied the complete-sample contract counts as
      // data. A tick made entirely of incomplete or replayed samples leaves the
      // clock running.
      if (results.some((r) => r.status !== 'incomplete_sample')) {
        this.lastDataAtMs = Date.now()
      }

      // Alert state changes are decided for every service first; the slow part,
      // notifier I/O, then runs for all of them together.
      const deliveries = []
      const touched = []
      for (const result of results) {
        this.latest.set(result.service, result)
        if (result.status !== 'evaluated') continue

        const outcome = this.alerts.evaluate({ service: result.service, evaluation: result.evaluation })

        if (outcome.type === 'opened') {
          this.logger.warn('incident.opened', {
            incident: outcome.incident.id,
            service: outcome.incident.service,
            R: outcome.incident.triggerR,
            signals: outcome.incident.triggerSignalCount,
            heldUntil: outcome.incident.heldUntil ?? null,
          })
          deliveries.push({ type: 'incident.opened', incident: outcome.incident })
          touched.push(outcome.incident)
        } else if (outcome.type === 'updated') {
          // An incident that was never fully sent — silenced, held by the
          // cooldown, or a notifier that failed — is announced (or retried) as
          // soon as nothing stops it, for as long as it is still firing.
          if (!outcome.incident.notifiedAt) {
            deliveries.push({ type: 'incident.opened', incident: outcome.incident })
          }
          touched.push(outcome.incident)
        } else if (outcome.type === 'resolved') {
          this.logger.info('incident.resolved', {
            incident: outcome.incident.id,
            service: outcome.incident.service,
            windowsFiring: outcome.incident.windowsFiring,
            peakR: outcome.incident.peakR,
          })
          if (outcome.incident.notifiedAt || outcome.incident.deliveredTo?.length) {
            deliveries.push({ type: 'incident.resolved', incident: outcome.incident })
          }
          touched.push(outcome.incident)
        }
      }

      await this.deliver(deliveries)
      // Persisted after delivery so the stored record carries what was sent.
      for (const incident of touched) this.store.upsertIncident(incident)

      this.retireSilentServices()

      if (this.ticks % this.config.storage.snapshotEveryTicks === 0) {
        this.snapshotDetectionState()
      }

      this.logger.debug('agent.tick', { ticks: this.ticks, services: results.length })
    } finally {
      this.ticking = false
      this.tickDone = null
      this.tickStartedAtMs = null
      this.lastTickCompletedAtMs = Date.now()
      settle()
    }
  }

  snapshot() {
    const alertStates = new Map(this.alerts.snapshot().map((s) => [s.service, s]))

    const services = [...this.latest.values()].map((result) => {
      const alert = alertStates.get(result.service)
      const base = {
        service: result.service,
        // Which per-service override rule applied, so an operator can tell at a
        // glance whether their config is actually in effect.
        profile: result.profile ?? null,
        status: result.status,
        windowsBuffered: result.windowsBuffered,
        firing: alert?.status === 'firing',
        incidentId: alert?.incidentId ?? null,
        silencedBy: this.silences.matching(result.service)?.id ?? null,
      }
      if (result.status === 'incomplete_sample') {
        return { ...base, missingMetrics: result.missing }
      }
      if (result.status === 'evaluation_failed') {
        return { ...base, error: result.error }
      }
      if (result.status !== 'evaluated') {
        return { ...base, windowsRequired: result.windowsRequired }
      }
      return {
        ...base,
        timestamp: result.evaluation.timestamp,
        R_score: result.evaluation.R_score,
        confidence: result.evaluation.confidence,
        signal_count: result.evaluation.signal_count,
        qualified_signals: result.evaluation.qualified_signals,
        metrics: result.evaluation.metrics,
        raw: result.evaluation.raw,
      }
    })

    return {
      name: this.name,
      version: VERSION,
      running: this.running,
      uptimeSeconds: this.startedAtMs ? Math.round((Date.now() - this.startedAtMs) / 1000) : 0,
      source: this.source.name,
      sourceState: this.source.state?.() ?? null,
      intervalSeconds: this.intervalSeconds,
      triggerThreshold: this.config.detector.triggerThreshold,
      serviceProfiles: this.serviceRules.map((r) => ({
        match: r.match,
        name: r.name,
        overrides: Object.keys(r.overrides),
      })),
      ticks: this.ticks,
      collectErrors: this.collectErrors,
      consecutiveCollectErrors: this.consecutiveCollectErrors,
      lastCollectAt: this.lastCollectAt,
      emptyCollections: this.emptyCollections,
      consecutiveEmptyCollections: this.consecutiveEmptyCollections,
      health: this.health(),
      liveness: this.liveness(),
      dataQuality: this.detector.dataQuality(),
      services: services.sort((a, b) => a.service.localeCompare(b.service)),
      retiredServices: this.retiredServices,
      recentRetirements: this.recentRetirements,
      stateRestored: this.stateRestore ?? { restored: false, reason: 'not_started' },
      silences: this.silences.list({ activeOnly: true }).length,
      incidents: this.store.stats(),
    }
  }

  /**
   * Services ordered by current cascade risk, most at-risk first.
   *
   * This is the honest primary use of the tool. Measured against real
   * production telemetry the detector reaches ~14% precision (docs/BACKTEST.md),
   * which is poor for waking someone at 3am but genuinely useful for answering
   * "where should I look first?" — a ranked list costs a glance to be wrong
   * about, where a page costs a night.
   *
   * Services still filling their baseline are returned last with a null score,
   * never as low risk: "not yet known" and "known to be fine" are different
   * answers and collapsing them would be a lie of omission.
   */
  ranking({ limit = 50 } = {}) {
    const services = this.snapshot().services
    const evaluated = services
      .filter((s) => s.status === 'evaluated')
      .sort((a, b) => b.R_score - a.R_score)
    const warming = services.filter((s) => s.status !== 'evaluated')

    const rows = [...evaluated, ...warming].slice(0, limit).map((s, i) => ({
      rank: i + 1,
      service: s.service,
      status: s.status,
      R_score: s.status === 'evaluated' ? s.R_score : null,
      signal_count: s.status === 'evaluated' ? s.signal_count : null,
      qualified_signals: s.qualified_signals ?? [],
      firing: s.firing,
      silenced: Boolean(s.silencedBy),
      profile: s.profile ?? null,
    }))

    return {
      generatedAt: new Date().toISOString(),
      triggerThreshold: this.config.detector.triggerThreshold,
      evaluated: evaluated.length,
      warmingUp: warming.length,
      services: rows,
    }
  }

  /**
   * Ordered shutdown.
   *
   * The ordering matters and the previous version got it wrong in a way that
   * loses work: it closed the store while a collection could still be in
   * flight, so a tick that completed afterwards advanced detection state,
   * scheduled more work, and wrote into a closed store. The sequence here is:
   * stop admitting new ticks, let the current one finish (bounded), stop the
   * server and source, snapshot exactly once, then close.
   *
   * `graceMs` bounds the wait. A source wedged on a socket must not hold a
   * SIGTERM open until the orchestrator sends SIGKILL, so after the grace
   * period the agent gives up on the in-flight tick and saves what it has.
   */
  async stop({ graceMs = 5000 } = {}) {
    if (this.stopping) return this.stopping
    this.signalStopRequested()
    this.stopping = (async () => {
      this.running = false

      // No further scheduled work, before anything is torn down.
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }

      if (this.ticking && this.tickDone) {
        const timedOut = Symbol('timeout')
        let timer
        const deadline = new Promise((resolve) => {
          // Deliberately kept ref'd: this timer *is* the grace period. Unref'ing
          // it lets Node call the loop empty and tear down mid-shutdown when
          // nothing else happens to be pending, cutting the wait short. It is
          // cleared immediately after the race, so it cannot delay exit either.
          timer = setTimeout(() => resolve(timedOut), graceMs)
        })
        const outcome = await Promise.race([this.tickDone, deadline])
        clearTimeout(timer)
        if (outcome === timedOut) {
          this.logger.warn('agent.shutdown_tick_abandoned', {
            graceMs,
            message: 'in-flight collection did not finish within the grace period; saving state anyway',
          })
        }
      }

      if (this.server) {
        await new Promise((resolve) => this.server.close(resolve))
        this.server = null
      }

      await this.source.close?.()

      // A clean shutdown always saves, so a rolling deploy costs no warm-up.
      // Exactly once: the tick loop can no longer reach snapshotDetectionState.
      if (this.ticks > 0) this.snapshotDetectionState()
      try {
        await this.store.close()
      } catch (err) {
        // Shutdown still completes; the caller learns that state was not saved
        // (the CLI exits non-zero) instead of the failure vanishing.
        this.logger.error('agent.state_save_failed', { path: this.store.path, message: err.message })
        throw err
      } finally {
        this.logger.info('agent.stopped', { ticks: this.ticks })
      }
    })()

    return this.stopping
  }
}
