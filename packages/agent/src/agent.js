import { detectorParams } from './config.js'
import { compileServiceRules, createParamsResolver } from './serviceConfig.js'
import { createLogger } from './logger.js'
import { createSource } from './sources/index.js'
import { RollingDetector } from './detector.js'
import { AlertManager } from './alerts.js'
import { createNotifiers } from './notifiers/index.js'
import { Store } from './store.js'
import { createApiServer } from './server.js'

export const VERSION = '1.0.0'

export class FaultlineAgent {
  constructor(config, { logger } = {}) {
    this.config = config
    this.logger = logger ?? createLogger(config.logging)
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
    this.store = new Store({ ...config.storage, logger: this.logger })

    this.server = null
    this.timer = null
    this.running = false
    this.ticking = false
    this.ticks = 0
    this.collectErrors = 0
    this.consecutiveCollectErrors = 0
    this.lastCollectAt = null
    this.startedAtMs = null
    this.latest = new Map()
  }

  async start() {
    await this.store.load()
    this.running = true
    this.startedAtMs = Date.now()

    if (this.config.server.enabled) {
      this.server = createApiServer(this, { logger: this.logger })
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.config.server.port, this.config.server.host, resolve)
      })
      const { address, port } = this.server.address()
      this.logger.info('server.listening', { url: `http://${address}:${port}` })
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

    await this.tick()
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error('agent.tick_failed', { message: err.message }))
    }, this.intervalSeconds * 1000)
    this.timer.unref?.()

    return this
  }

  async tick() {
    // A slow source must never let two collection cycles overlap.
    if (this.ticking) {
      this.logger.warn('agent.tick_skipped', { reason: 'previous tick still running' })
      return
    }
    this.ticking = true

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

      const results = this.detector.ingest(samples)

      for (const result of results) {
        this.latest.set(result.service, result)
        if (result.status !== 'evaluated') continue

        const outcome = this.alerts.evaluate({ service: result.service, evaluation: result.evaluation })

        if (outcome.type === 'opened') {
          this.store.upsertIncident(outcome.incident)
          this.logger.warn('incident.opened', {
            incident: outcome.incident.id,
            service: outcome.incident.service,
            R: outcome.incident.triggerR,
            signals: outcome.incident.triggerSignalCount,
          })
          await this.notifiers.notify({
            type: 'incident.opened',
            agent: this.name,
            incident: outcome.incident,
          })
        } else if (outcome.type === 'updated') {
          this.store.upsertIncident(outcome.incident)
        } else if (outcome.type === 'resolved') {
          this.store.upsertIncident(outcome.incident)
          this.logger.info('incident.resolved', {
            incident: outcome.incident.id,
            service: outcome.incident.service,
            windowsFiring: outcome.incident.windowsFiring,
            peakR: outcome.incident.peakR,
          })
          await this.notifiers.notify({
            type: 'incident.resolved',
            agent: this.name,
            incident: outcome.incident,
          })
        } else if (outcome.type === 'suppressed') {
          this.logger.info('incident.suppressed', {
            service: result.service,
            reason: outcome.reason,
            retryAfterMs: outcome.retryAfterMs,
          })
        }
      }

      this.logger.debug('agent.tick', { ticks: this.ticks, services: results.length })
    } finally {
      this.ticking = false
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
      services: services.sort((a, b) => a.service.localeCompare(b.service)),
      incidents: this.store.stats(),
    }
  }

  async stop() {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve))
      this.server = null
    }
    await this.source.close?.()
    await this.store.close()
    this.logger.info('agent.stopped', { ticks: this.ticks })
  }
}
