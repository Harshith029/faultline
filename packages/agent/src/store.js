import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/**
 * Durable incident history. Writes are atomic (temp file + rename) so a crash
 * mid-write cannot corrupt the state file, and are debounced so a fast tick
 * interval does not turn into a write storm.
 */
export class Store {
  constructor({ path, maxIncidents = 200, flushIntervalMs = 2000, logger }) {
    this.path = resolve(path)
    this.maxIncidents = maxIncidents
    this.flushIntervalMs = flushIntervalMs
    this.logger = logger
    this.incidents = []
    this.dirty = false
    this.timer = null
    this.startedAt = new Date().toISOString()
  }

  async load() {
    try {
      const contents = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(contents)
      if (Array.isArray(parsed?.incidents)) this.incidents = parsed.incidents
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
    return {
      total: this.incidents.length,
      firing: this.incidents.filter((i) => i.status === 'firing').length,
      resolved: this.incidents.filter((i) => i.status === 'resolved').length,
    }
  }

  markDirty() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch((err) => this.logger?.error('store.flush_failed', { message: err.message }))
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  async flush() {
    if (!this.dirty) return false
    this.dirty = false
    const payload = JSON.stringify(
      { version: 1, updatedAt: new Date().toISOString(), incidents: this.incidents },
      null,
      2
    )
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, this.path)
    return true
  }

  async close() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }
}
