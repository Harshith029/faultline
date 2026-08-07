import { globToRegExp } from './serviceConfig.js'

let counter = 0

const nextId = () => {
  counter = (counter + 1) % 100000
  return `sil_${Date.now().toString(36)}${counter.toString(36)}`
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

const minutesOfDay = (raw) => {
  const match = HHMM.exec(String(raw ?? ''))
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function validateSilence(silence) {
  const errors = []
  if (typeof silence?.match !== 'string' || silence.match.trim() === '') {
    errors.push('"match" is required (exact service name or glob)')
  }
  // Absent fields may arrive as undefined (from a config file) or as null (from
  // a persisted runtime silence). Both mean "not set".
  for (const key of ['from', 'until']) {
    if (silence?.[key] != null && Number.isNaN(Date.parse(silence[key]))) {
      errors.push(`"${key}" must be an ISO timestamp`)
    }
  }
  if (silence?.daily != null) {
    if (minutesOfDay(silence.daily?.start) === null || minutesOfDay(silence.daily?.end) === null) {
      errors.push('"daily" requires start and end as HH:MM (UTC)')
    }
  }
  if (silence?.days != null) {
    if (
      !Array.isArray(silence.days) ||
      silence.days.length === 0 ||
      silence.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    ) {
      errors.push('"days" must be a non-empty array of integers 0-6 (0 = Sunday, UTC)')
    }
  }
  return errors
}

/**
 * Suppresses notifications for matching services during maintenance.
 *
 * Detection deliberately keeps running while a service is silenced: the risk
 * score stays visible and the incident is still recorded, so a postmortem can
 * see what happened during the window. Only the page is withheld.
 */
export class SilenceManager {
  constructor({ configSilences = [], logger, now = () => Date.now() } = {}) {
    this.logger = logger
    this.now = now
    this.config = configSilences.map((silence, i) => ({
      ...silence,
      id: `cfg:${silence.name ?? silence.match}:${i}`,
      source: 'config',
    }))
    this.runtime = []
  }

  add(input) {
    const errors = validateSilence(input)
    if (errors.length) throw new Error(`Invalid silence: ${errors.join('; ')}`)

    const silence = {
      id: nextId(),
      source: 'runtime',
      match: input.match,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(this.now()).toISOString(),
      from: input.from ?? null,
      until: input.until ?? null,
      daily: input.daily ?? null,
      days: input.days ?? null,
    }
    this.runtime.push(silence)
    this.logger?.info('silence.added', { id: silence.id, match: silence.match, until: silence.until })
    return silence
  }

  remove(id) {
    const index = this.runtime.findIndex((s) => s.id === id)
    if (index === -1) return false
    const [removed] = this.runtime.splice(index, 1)
    this.logger?.info('silence.removed', { id, match: removed.match })
    return true
  }

  hydrate(silences = []) {
    for (const silence of silences) {
      if (validateSilence(silence).length === 0) this.runtime.push(silence)
    }
    this.prune()
  }

  /** Drops runtime silences whose end time has passed, so they cannot pile up. */
  prune(atMs = this.now()) {
    const before = this.runtime.length
    this.runtime = this.runtime.filter((s) => !s.until || Date.parse(s.until) > atMs)
    return before - this.runtime.length
  }

  all() {
    return [...this.config, ...this.runtime]
  }

  isActive(silence, atMs) {
    if (silence.from && atMs < Date.parse(silence.from)) return false
    if (silence.until && atMs > Date.parse(silence.until)) return false

    if (silence.daily) {
      const at = new Date(atMs)
      if (silence.days && !silence.days.includes(at.getUTCDay())) return false
      const minutes = at.getUTCHours() * 60 + at.getUTCMinutes()
      const start = minutesOfDay(silence.daily.start)
      const end = minutesOfDay(silence.daily.end)
      // A window such as 22:00-02:00 wraps past midnight.
      return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
    }

    if (silence.days) {
      return silence.days.includes(new Date(atMs).getUTCDay())
    }

    return true
  }

  /** The first active silence covering this service, or null. */
  matching(service, atMs = this.now()) {
    return (
      this.all().find((s) => this.isActive(s, atMs) && globToRegExp(s.match).test(service)) ?? null
    )
  }

  isSilenced(service, atMs = this.now()) {
    return this.matching(service, atMs) !== null
  }

  list({ activeOnly = false, atMs = this.now() } = {}) {
    return this.all()
      .filter((s) => (activeOnly ? this.isActive(s, atMs) : true))
      .map((s) => ({ ...s, active: this.isActive(s, atMs) }))
  }

  /** Only runtime silences are persisted; config silences come from the file. */
  persistable() {
    return this.runtime
  }
}
