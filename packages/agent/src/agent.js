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
    this.ticks = 0
    this.collectErrors = 0
    this.consecutiveCollectErrors = 0
    this.lastCollectAt = null
    this.startedAtMs = null
    this.latest = new Map()

    // A successful HTTP call that returns nothing is not the same as telemetry.
    // These track "did we actually observe anything" independently of "did the
    // collection call succeed".
    this.emptyCollections = 0
    this.consecutiveEmptyCollections = 0
    this.lastDataAtMs = null
    this.noDataGraceSeconds = config.detector.noDataGraceSeconds
  }

  /**
   * Health distinguishes three things that a single boolean would conflate:
   * the process is alive, collection is succeeding, and the data is usable.
   *
   * An exporter rename or a permissions regression produces a perfectly
   * successful collection that observes nothing. Reporting that as `ok` is what
   * makes telemetry loss look like good news, so it degrades once the grace
   * period has passed.
   */
  health(nowMs = Date.now()) {
    const reasons = []

    if (!this.running) reasons.push('agent_stopped')
    if (this.consecutiveCollectErrors >= 3) reasons.push('collection_failing')

    const graceMs = this.noDataGraceSeconds * 1000
    // Measured from the last observation, or from startup if there has never
    // been one, so a source that is broken from the first tick still degrades.
    const sinceDataMs = nowMs - (this.lastDataAtMs ?? this.startedAtMs ?? nowMs)
    const noDataTooLong = this.startedAtMs !== null && sinceDataMs > graceMs
    if (noDataTooLong) {
      reasons.push(this.lastDataAtMs === null ? 'no_telemetry_since_start' : 'telemetry_stale')
    }

    // A collection can still contain valid samples while one previously seen
    // service has vanished. Global freshness alone would call that healthy and
    // hide the partial outage. Once a service has supplied a complete sample,
    // it becomes an expected telemetry target until the agent restarts.
    const staleServices = this.detector
      .freshness(nowMs)
      .filter((entry) => Number.isFinite(entry.staleSeconds) && entry.staleSeconds > this.noDataGraceSeconds)
      .map((entry) => entry.service)
    if (staleServices.length > 0) reasons.push('service_telemetry_stale')

    return {
      status: reasons.length === 0 ? 'ok' : 'degraded',
      reasons,
      secondsSinceData: this.startedAtMs === null ? null : Math.round(sinceDataMs / 1000),
      noDataGraceSeconds: this.noDataGraceSeconds,
      lastDataAt: this.lastDataAtMs ? new Date(this.lastDataAtMs).toISOString() : null,
      staleServices,
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

    return {
      restored: true,
      ageSeconds,
      samples: this.detector.hydrateBuffers(state.buffers),
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
   * Sends an alert unless the service is silenced.
   *
   * `notifiedAt` is what makes a maintenance window safe: an incident that
   * opens while silenced is recorded but not sent, and if it is still firing
   * once the window ends it is announced then rather than being lost. A resolve
   * is only sent if the open was.
   */
  async maybeNotify(type, incident) {
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

    await this.notifiers.notify({ type, agent: this.name, incident })
    // `notifiedAt` records successful delivery, so it can only be set after the
    // await. Two notifications for one incident cannot interleave: ticks are
    // serialised by the `ticking` guard and a tick handles each service once.
    // eslint-disable-next-line require-atomic-updates
    if (type === 'incident.opened') incident.notifiedAt = new Date().toISOString()
    return true
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

      const results = this.detector.ingest(samples)

      // Only a sample that satisfied the complete-sample contract counts as
      // data. A tick made entirely of incomplete samples leaves the clock running.
      if (results.some((r) => r.status !== 'incomplete_sample')) {
        this.lastDataAtMs = Date.now()
      }

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
          })
          await this.maybeNotify('incident.opened', outcome.incident)
          this.store.upsertIncident(outcome.incident)
        } else if (outcome.type === 'updated') {
          // A silence that expires mid-incident should still page: announce an
          // incident that was never sent once it is no longer suppressed.
          if (!outcome.incident.notifiedAt) {
            await this.maybeNotify('incident.opened', outcome.incident)
          }
          this.store.upsertIncident(outcome.incident)
        } else if (outcome.type === 'resolved') {
          this.logger.info('incident.resolved', {
            incident: outcome.incident.id,
            service: outcome.incident.service,
            windowsFiring: outcome.incident.windowsFiring,
            peakR: outcome.incident.peakR,
          })
          if (outcome.incident.notifiedAt) {
            await this.maybeNotify('incident.resolved', outcome.incident)
          }
          this.store.upsertIncident(outcome.incident)
        } else if (outcome.type === 'suppressed') {
          this.logger.info('incident.suppressed', {
            service: result.service,
            reason: outcome.reason,
            retryAfterMs: outcome.retryAfterMs,
          })
        }
      }

      if (this.ticks % this.config.storage.snapshotEveryTicks === 0) {
        this.snapshotDetectionState()
      }

      this.logger.debug('agent.tick', { ticks: this.ticks, services: results.length })
    } finally {
      this.ticking = false
      this.tickDone = null
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
      dataQuality: this.detector.dataQuality(),
      services: services.sort((a, b) => a.service.localeCompare(b.service)),
      stateRestored: this.stateRestore ?? { restored: false, reason: 'not_started' },
      silences: this.silences.list({ activeOnly: true }).length,
      incidents: this.store.stats(),
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
      await this.store.close()
      this.logger.info('agent.stopped', { ticks: this.ticks })
    })()

    return this.stopping
  }
}
