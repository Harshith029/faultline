const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const DEFAULT_SERVICES = [
  { name: 'checkout-api', p99_latency: 120, retry_rate: 0.8, error_rate: 0.4 },
  { name: 'payments', p99_latency: 95, retry_rate: 0.6, error_rate: 0.3 },
  { name: 'inventory', p99_latency: 70, retry_rate: 0.5, error_rate: 0.25 },
]

const DEFAULT_NOISE = { p99_latency: 15, retry_rate: 0.25, error_rate: 0.15 }

// Latency degrades first, retries amplify a beat later, errors surface last:
// the ordering that makes a cascade distinguishable from a single-metric blip.
// Gains are sized so a full-intensity incident lands around 5-6 sigma per
// metric — severe, but in the range real degradations actually produce.
const DEFAULT_RAMP = {
  p99_latency: { delay: 0, gain: 70 },
  retry_rate: { delay: 2, gain: 0.9 },
  error_rate: { delay: 4, gain: 0.5 },
}

/**
 * Deterministic synthetic telemetry with an optional injected cascade.
 * Exists so the agent can be run and observed end-to-end with no external
 * infrastructure — and so tests can assert on reproducible detection.
 */
export function createSyntheticSource(options = {}, ctx = {}) {
  const services = options.services ?? DEFAULT_SERVICES
  const noise = { ...DEFAULT_NOISE, ...(options.noise ?? {}) }
  const ramp = { ...DEFAULT_RAMP, ...(options.ramp ?? {}) }
  const rampWindows = options.rampWindows ?? 10
  const holdWindows = options.holdWindows ?? 6
  const recoverWindows = options.recoverWindows ?? 8
  const random = mulberry32(options.seed ?? 42)
  const logger = ctx.logger

  let tick = 0
  const incidents = new Map()

  if (options.incident) {
    incidents.set(options.incident.service ?? services[0].name, {
      startTick: options.incident.startAfterWindows ?? 12,
      scheduled: true,
    })
  }

  const intensity = (incident, currentTick) => {
    if (!incident || currentTick < incident.startTick) return 0
    const elapsed = currentTick - incident.startTick
    if (elapsed < rampWindows) return elapsed / rampWindows
    if (elapsed < rampWindows + holdWindows) return 1
    const recovering = elapsed - rampWindows - holdWindows
    if (recovering >= recoverWindows) return 0
    return Math.max(0, 1 - recovering / recoverWindows)
  }

  return {
    name: 'synthetic',

    inject(service, { startAfterWindows = 0 } = {}) {
      const target = service ?? services[0].name
      incidents.set(target, { startTick: tick + startAfterWindows, scheduled: false })
      logger?.warn('source.incident_injected', { service: target, atTick: tick })
      return { service: target, startsAtTick: tick + startAfterWindows }
    },

    clear(service) {
      if (service) incidents.delete(service)
      else incidents.clear()
      return { cleared: service ?? 'all' }
    },

    async collect() {
      const timestamp = new Date().toISOString()
      const samples = services.map((service) => {
        const factor = intensity(incidents.get(service.name), tick)
        const elapsed = tick - (incidents.get(service.name)?.startTick ?? 0)

        const sample = { service: service.name, timestamp }
        for (const metric of ['p99_latency', 'retry_rate', 'error_rate']) {
          const jitter = (random() - 0.5) * 2 * noise[metric]
          const { delay, gain } = ramp[metric]
          // Each metric only starts climbing once its own delay has passed.
          const metricFactor = factor > 0 && elapsed >= delay ? factor : 0
          const value = service[metric] + jitter + metricFactor * gain
          sample[metric] = Math.max(0, Number(value.toFixed(3)))
        }
        return sample
      })

      tick += 1
      return samples
    },

    state() {
      return {
        tick,
        services: services.map((s) => s.name),
        incidents: [...incidents.entries()].map(([service, i]) => ({
          service,
          startTick: i.startTick,
          intensity: Number(intensity(i, tick).toFixed(2)),
        })),
      }
    },
  }
}
