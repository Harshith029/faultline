import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Upper bound on the backoff between retries of a failing write, so a full disk
// is retried about once a minute rather than logged every couple of seconds.
const MAX_RETRY_DELAY_MS = 60_000

/**
 * Durable incident history. Writes are atomic (temp file + rename) so a crash
 * mid-write cannot corrupt the state file, and are debounced so a fast tick
 * interval does not turn into a write storm.
 *
 * Writes are also serialised and retried. Two flushes running at once share one
 * temp file and race each other's rename; and a write that fails must leave the
 * state marked unsaved and try again, rather than wait for a next change that
 * an idle agent may never make.
 */
export class Store {
  constructor({ path, maxIncidents = 200, flushIntervalMs = 2000, logger }) {
    this.path = resolve(path)
    this.maxIncidents = maxIncidents
    this.flushIntervalMs = flushIntervalMs
    this.logger = logger
    this.incidents = []
    this.silences = []
    this.detectionState = null
    this.dirty = false
    this.timer = null
    this.closed = false
    this.failing = false
    this.flushing = Promise.resolve()
    this.retryDelayMs = flushIntervalMs
    this.startedAt = new Date().toISOString()
  }

  async load() {
    try {
      const contents = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(contents)
      if (Array.isArray(parsed?.incidents)) this.incidents = parsed.incidents
      if (Array.isArray(parsed?.silences)) this.silences = parsed.silences
      if (parsed?.detectionState) this.detectionState = parsed.detectionState
      this.logger?.info('store.loaded', { path: this.path, incidents: this.incidents.length })
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger?.warn('store.load_failed', { path: this.path, message: err.message })
      }
    }
    return this
  }

  upsertIncident(incident) {
    const index = this.incidents.findIndex((i) => i.id === incident.id)
    const record = structuredClone(incident)
    if (index === -1) this.incidents.unshift(record)
    else this.incidents[index] = record
    if (this.incidents.length > this.maxIncidents) this.incidents.length = this.maxIncidents
    this.markDirty()
    return record
  }

  getIncidents({ limit = 50, status, service } = {}) {
    return this.incidents
      .filter((i) => (status ? i.status === status : true))
      .filter((i) => (service ? i.service === service : true))
      .slice(0, limit)
  }

  getIncident(id) {
    return this.incidents.find((i) => i.id === id) ?? null
  }

  stats() {
    const count = (status) => this.incidents.filter((i) => i.status === status).length
    return {
      total: this.incidents.length,
      firing: count('firing'),
      resolved: count('resolved'),
      // Closed because the service was taken out of monitoring, not observed
      // to recover; see AlertManager.retire.
      retired: count('retired'),
    }
  }

  markDirty() {
    this.dirty = true
    // While writes are failing, the next attempt waits out the backoff. A new
    // change must not pull it forward, or a busy agent on a full disk retries
    // (and logs an error) every couple of seconds.
    this.scheduleFlush(this.failing ? this.retryDelayMs : this.flushIntervalMs)
  }

  scheduleFlush(delayMs) {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().then(
        () => {
          // A change made while the write was in flight still needs saving.
          if (this.dirty) this.scheduleFlush(this.flushIntervalMs)
        },
        (err) => {
          // Still dirty, so retry on a backoff instead of waiting for the next
          // change, which may never come if the agent goes quiet.
          this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS)
          this.logger?.error('store.flush_failed', {
            path: this.path,
            message: err.message,
            retryInMs: this.retryDelayMs,
          })
          // The backoff timer replaces any regular one armed in the meantime.
          if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
          }
          this.scheduleFlush(this.retryDelayMs)
        }
      )
    }, delayMs)
    this.timer.unref?.()
  }

  /** Writes the state if anything changed. Calls are queued, never concurrent. */
  flush() {
    const run = this.flushing.then(() => this.writeIfDirty())
    this.flushing = run.catch(() => {})
    return run
  }

  async writeIfDirty() {
    if (!this.dirty) return false
    // Cleared before the write, so a change made while it is in flight marks
    // the store dirty again and is saved by the next flush; restored below if
    // this write fails, so the failure cannot pass for a successful save.
    this.dirty = false
    const payload = JSON.stringify(
      {
        version: 3,
        updatedAt: new Date().toISOString(),
        incidents: this.incidents,
        silences: this.silences,
        detectionState: this.detectionState,
      },
      null,
      2
    )
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.path)
    } catch (err) {
      this.dirty = true
      this.failing = true
      throw err
    }
    this.failing = false
    this.retryDelayMs = this.flushIntervalMs
    return true
  }

  async close() {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }
}
