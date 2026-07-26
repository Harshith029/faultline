let counter = 0

const nextIncidentId = (service, startedAtMs) => {
  counter = (counter + 1) % 100000
  return `inc_${service.replace(/[^a-zA-Z0-9_-]/g, '-')}_${startedAtMs.toString(36)}${counter.toString(36)}`
}

/**
 * Incident lifecycle for a continuously running detector.
 *
 * Deliberate properties:
 *  - An incident opens on the first triggered window and stays open while the
 *    detector keeps triggering, so one cascade produces one incident, not one
 *    alert per window.
 *  - It resolves only after `resolveAfterWindows` consecutive clean windows,
 *    so a single clean sample mid-incident does not close it prematurely.
 *  - After resolution a cooldown suppresses immediate re-opening, which is what
 *    stops a flapping service from paging someone every window.
 */
export class AlertManager {
  constructor({ cooldownSeconds = 300, resolveAfterWindows = 3 } = {}) {
    this.cooldownMs = cooldownSeconds * 1000
    this.resolveAfterWindows = resolveAfterWindows
    this.states = new Map()
  }

  stateFor(service) {
    let state = this.states.get(service)
    if (!state) {
      state = { status: 'ok', incident: null, clearStreak: 0, lastResolvedAt: null }
      this.states.set(service, state)
    }
    return state
  }

  snapshot() {
    return [...this.states.entries()].map(([service, s]) => ({
      service,
      status: s.status,
      incidentId: s.incident?.id ?? null,
      clearStreak: s.clearStreak,
    }))
  }

  evaluate({ service, evaluation, nowMs = Date.now() }) {
    const state = this.stateFor(service)
    const at = new Date(nowMs).toISOString()

    if (evaluation.triggered) {
      state.clearStreak = 0

      if (state.status === 'firing') {
        const incident = state.incident
        incident.lastSeenAt = at
        incident.lastR = evaluation.R_score
        incident.peakR = Math.max(incident.peakR, evaluation.R_score)
        incident.peakSignalCount = Math.max(incident.peakSignalCount, evaluation.signal_count)
        incident.signals = evaluation.qualified_signals
        incident.windowsFiring += 1
        return { type: 'updated', incident }
      }

      if (state.lastResolvedAt !== null && nowMs - state.lastResolvedAt < this.cooldownMs) {
        return {
          type: 'suppressed',
          service,
          reason: 'cooldown',
          retryAfterMs: this.cooldownMs - (nowMs - state.lastResolvedAt),
        }
      }

      const incident = {
        id: nextIncidentId(service, nowMs),
        service,
        status: 'firing',
        startedAt: at,
        lastSeenAt: at,
        endedAt: null,
        triggerR: evaluation.R_score,
        peakR: evaluation.R_score,
        lastR: evaluation.R_score,
        triggerSignalCount: evaluation.signal_count,
        peakSignalCount: evaluation.signal_count,
        signals: evaluation.qualified_signals,
        windowsFiring: 1,
        metrics: evaluation.metrics,
      }
      state.status = 'firing'
      state.incident = incident
      return { type: 'opened', incident }
    }

    if (state.status !== 'firing') return { type: 'none', service }

    state.clearStreak += 1
    if (state.clearStreak < this.resolveAfterWindows) {
      return { type: 'recovering', incident: state.incident, clearStreak: state.clearStreak }
    }

    const incident = state.incident
    incident.status = 'resolved'
    incident.endedAt = at
    incident.durationMs = new Date(at).getTime() - new Date(incident.startedAt).getTime()
    state.status = 'ok'
    state.incident = null
    state.clearStreak = 0
    state.lastResolvedAt = nowMs
    return { type: 'resolved', incident }
  }
}
