const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const gaussian = (rng) => {
  const u = Math.max(rng(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

// Baselines chosen so each metric's noise sigma exceeds the engine's relative
// sigma floor, which keeps "+3 sigma" in a scenario literally three sigma.
export const BASELINE = {
  p99_latency: { level: 120, sigma: 10 },
  retry_rate: { level: 0.8, sigma: 0.15 },
  error_rate: { level: 0.4, sigma: 0.1 },
}

const METRICS = Object.keys(BASELINE)

const WINDOWS = 60

/**
 * Builds a telemetry series. `shapes` express the anomaly in sigma units, so a
 * scenario reads the same regardless of each metric's absolute scale.
 */
function build({ windows = WINDOWS, shapes = {}, noiseScale = 1, seed = 1 }) {
  const rng = mulberry32(seed)
  const series = []
  for (let i = 0; i < windows; i++) {
    const row = {
      window_number: i + 1,
      window_timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }
    for (const metric of METRICS) {
      const { level, sigma } = BASELINE[metric]
      const shift = shapes[metric]?.(i) ?? 0
      const value = level + gaussian(rng) * sigma * noiseScale + shift * sigma
      row[metric] = Math.max(0, Number(value.toFixed(4)))
    }
    series.push(row)
  }
  return series
}

const ramp = (start, length, peak) => (i) => {
  if (i < start) return 0
  const progress = Math.min((i - start) / length, 1)
  return progress * peak
}

const SCENARIOS = [
  {
    name: 'classic-cascade',
    expect: 'fire',
    onset: 30,
    note: 'Latency degrades, retries amplify, errors follow — the canonical convergence pattern.',
    shapes: {
      p99_latency: ramp(30, 10, 5),
      retry_rate: ramp(33, 10, 4.5),
      error_rate: ramp(36, 10, 4),
    },
  },
  {
    name: 'slow-burn',
    expect: 'fire',
    onset: 20,
    note: 'Gradual multi-signal degradation over 35 windows, e.g. a leak.',
    shapes: {
      p99_latency: ramp(20, 35, 4),
      retry_rate: ramp(24, 35, 3.5),
      error_rate: ramp(28, 35, 3),
    },
  },
  {
    name: 'retry-storm',
    expect: 'fire',
    onset: 30,
    note: 'Client retry amplification leads; latency follows as the pool saturates.',
    shapes: {
      retry_rate: ramp(30, 8, 5),
      p99_latency: ramp(33, 8, 4),
      error_rate: ramp(37, 8, 3),
    },
  },
  {
    name: 'error-led-cascade',
    expect: 'fire',
    onset: 30,
    note: 'A bad deploy throws 5xx first; retries and latency follow.',
    shapes: {
      error_rate: ramp(30, 8, 5),
      retry_rate: ramp(32, 8, 4),
      p99_latency: ramp(35, 8, 3.5),
    },
  },
  {
    name: 'two-signal-cascade',
    expect: 'fire',
    onset: 30,
    note: 'Only latency and retries converge; error rate never moves.',
    shapes: {
      p99_latency: ramp(30, 10, 5),
      retry_rate: ramp(33, 10, 4.5),
    },
  },

  {
    name: 'single-window-spike',
    expect: 'quiet',
    note: 'One metric spikes 6 sigma for a single window. Classic transient noise.',
    shapes: {
      p99_latency: (i) => (i === 30 ? 6 : 0),
    },
  },
  {
    name: 'transient-multi-spike',
    expect: 'quiet',
    note: 'All metrics jump for two windows then recover — a blip, not a cascade.',
    shapes: {
      p99_latency: (i) => (i === 30 || i === 31 ? 4 : 0),
      retry_rate: (i) => (i === 30 || i === 31 ? 4 : 0),
      error_rate: (i) => (i === 30 || i === 31 ? 4 : 0),
    },
  },
  {
    name: 'isolated-sustained-metric',
    expect: 'quiet',
    note: 'One metric sits 3 sigma high indefinitely with no convergence. Tests whether a lone signal can page.',
    shapes: {
      p99_latency: (i) => (i >= 30 ? 3 : 0),
    },
  },
  {
    name: 'deploy-step-change',
    expect: 'quiet',
    note: 'A deploy permanently shifts every metric to a new normal. Should adapt, not alert forever.',
    shapes: {
      p99_latency: (i) => (i >= 30 ? 2.5 : 0),
      retry_rate: (i) => (i >= 30 ? 2.5 : 0),
      error_rate: (i) => (i >= 30 ? 2.5 : 0),
    },
  },
  {
    name: 'noisy-baseline',
    expect: 'quiet',
    note: 'Three times the normal variance, no trend. A chatty but healthy service.',
    noiseScale: 3,
    shapes: {},
  },
  {
    name: 'seasonal-traffic',
    expect: 'quiet',
    note: 'Smooth periodic load cycle, amplitude 1.5 sigma.',
    shapes: {
      p99_latency: (i) => 1.5 * Math.sin((i / 20) * 2 * Math.PI),
      retry_rate: (i) => 1.2 * Math.sin((i / 20) * 2 * Math.PI),
      error_rate: (i) => 1.0 * Math.sin((i / 20) * 2 * Math.PI),
    },
  },
  {
    name: 'organic-growth',
    expect: 'quiet',
    note: 'Steady linear growth across the whole window — the service is getting busier, not failing.',
    shapes: {
      p99_latency: (i) => (i / WINDOWS) * 1.5,
      retry_rate: (i) => (i / WINDOWS) * 1.5,
      error_rate: (i) => (i / WINDOWS) * 1.5,
    },
  },
]

export function scenarioNames() {
  return SCENARIOS.map((s) => s.name)
}

export function generateScenario(name, seed) {
  const spec = SCENARIOS.find((s) => s.name === name)
  if (!spec) throw new Error(`Unknown scenario "${name}"`)
  return {
    name: spec.name,
    expect: spec.expect,
    onset: spec.onset ?? null,
    note: spec.note,
    seed,
    windows: build({ shapes: spec.shapes, noiseScale: spec.noiseScale ?? 1, seed }),
  }
}

export function generateAll({ seeds = 20 } = {}) {
  const runs = []
  for (const spec of SCENARIOS) {
    for (let s = 0; s < seeds; s++) {
      runs.push(generateScenario(spec.name, 1000 + s * 7))
    }
  }
  return runs
}

export { SCENARIOS, WINDOWS }
