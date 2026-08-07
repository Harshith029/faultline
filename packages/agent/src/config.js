import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { OVERRIDABLE } from './serviceConfig.js'
import { validateSilence } from './silences.js'

export const DEFAULT_CONFIG = {
  agent: { name: 'faultline-agent' },
  source: { type: 'synthetic', options: {} },
  detector: {
    intervalSeconds: 60,
    historyWindows: 40,
    baselineWindows: 10,
    zThreshold: 2.0,
    minSustain: 2,
    minSignals: 2,
    triggerThreshold: 3.0,
    criticalityWeight: 1.0,
    sigmaFloorRatio: 0.1,
    sigmaFloorAbs: null,
    // Any set of numeric metrics your source emits. The engine is agnostic;
    // these three are simply the defaults the reference scenario uses.
    metrics: ['p99_latency', 'retry_rate', 'error_rate'],
  },
  // Per-service overrides. Each entry needs a `match` (exact name or glob) and
  // may override any detector parameter for the services it matches.
  services: [],
  // Recurring maintenance windows. Ad-hoc silences are added at runtime via
  // the API and persisted separately.
  silences: [],
  alerting: {
    cooldownSeconds: 300,
    resolveAfterWindows: 3,
    notifiers: [{ type: 'stdout' }],
  },
  server: { enabled: true, host: '127.0.0.1', port: 8787 },
  storage: { path: './data/faultline-state.json', maxIncidents: 200 },
  logging: { level: 'info', pretty: false },
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

const NUMERIC_RULES = {
  'detector.intervalSeconds': { min: 1 },
  'detector.historyWindows': { min: 5, integer: true },
  'detector.baselineWindows': { min: 2, integer: true },
  'detector.zThreshold': { min: 0 },
  'detector.minSustain': { min: 1, integer: true },
  'detector.minSignals': { min: 1, integer: true },
  'detector.triggerThreshold': { min: 0 },
  'detector.criticalityWeight': { min: 0 },
  'detector.sigmaFloorRatio': { min: 0 },
  'alerting.cooldownSeconds': { min: 0 },
  'alerting.resolveAfterWindows': { min: 1, integer: true },
  'server.port': { min: 0, max: 65535, integer: true },
  'storage.maxIncidents': { min: 1, integer: true },
}

const KNOWN_SOURCES = ['synthetic', 'prometheus', 'http', 'cloudwatch']
const KNOWN_NOTIFIERS = ['stdout', 'webhook', 'file']

const pick = (obj, path) => path.split('.').reduce((acc, k) => acc?.[k], obj)

export function validateConfig(config) {
  const errors = []

  if (!KNOWN_SOURCES.includes(config.source?.type)) {
    errors.push(`source.type must be one of ${KNOWN_SOURCES.join(', ')} (got ${JSON.stringify(config.source?.type)})`)
  }

  for (const [path, rule] of Object.entries(NUMERIC_RULES)) {
    const value = pick(config, path)
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path} must be a finite number (got ${JSON.stringify(value)})`)
      continue
    }
    if (rule.integer && !Number.isInteger(value)) errors.push(`${path} must be an integer (got ${value})`)
    if (rule.min !== undefined && value < rule.min) errors.push(`${path} must be >= ${rule.min} (got ${value})`)
    if (rule.max !== undefined && value > rule.max) errors.push(`${path} must be <= ${rule.max} (got ${value})`)
  }

  const { historyWindows, baselineWindows, minSustain } = config.detector ?? {}
  if (Number.isFinite(historyWindows) && Number.isFinite(baselineWindows) && Number.isFinite(minSustain)) {
    if (baselineWindows + minSustain > historyWindows) {
      errors.push(
        `detector.historyWindows (${historyWindows}) must be >= baselineWindows + minSustain (${baselineWindows + minSustain})`
      )
    }
  }

  if (!Array.isArray(config.alerting?.notifiers)) {
    errors.push('alerting.notifiers must be an array')
  } else {
    config.alerting.notifiers.forEach((n, i) => {
      if (!KNOWN_NOTIFIERS.includes(n?.type)) {
        errors.push(`alerting.notifiers[${i}].type must be one of ${KNOWN_NOTIFIERS.join(', ')}`)
      }
      if (n?.type === 'webhook' && !n.url && !n.urlEnv) {
        errors.push(`alerting.notifiers[${i}] (webhook) requires "url" or "urlEnv"`)
      }
      if (n?.type === 'file' && !n.path) {
        errors.push(`alerting.notifiers[${i}] (file) requires "path"`)
      }
    })
  }

  if (config.detector?.sigmaFloorAbs != null && !isPlainObject(config.detector.sigmaFloorAbs)) {
    errors.push('detector.sigmaFloorAbs must be an object of metric -> minimum sigma, or null')
  }

  const metrics = config.detector?.metrics
  if (!Array.isArray(metrics) || metrics.length === 0) {
    errors.push('detector.metrics must be a non-empty array of metric names')
  } else {
    if (metrics.some((m) => typeof m !== 'string' || m.trim() === '')) {
      errors.push('detector.metrics entries must be non-empty strings')
    }
    if (new Set(metrics).size !== metrics.length) {
      errors.push('detector.metrics must not contain duplicates')
    }
    if (Number.isFinite(config.detector?.minSignals) && config.detector.minSignals > metrics.length) {
      errors.push(
        `detector.minSignals (${config.detector.minSignals}) cannot exceed the number of metrics (${metrics.length})`
      )
    }
  }

  if (!Array.isArray(config.services)) {
    errors.push('services must be an array of per-service override rules')
  } else {
    const seen = new Set()
    config.services.forEach((rule, i) => {
      if (typeof rule?.match !== 'string' || rule.match.trim() === '') {
        errors.push(`services[${i}] requires a non-empty "match" (exact service name or glob)`)
        return
      }
      if (seen.has(rule.match)) errors.push(`services[${i}] duplicates match "${rule.match}"`)
      seen.add(rule.match)

      for (const key of Object.keys(rule)) {
        if (key !== 'match' && key !== 'name' && !OVERRIDABLE.includes(key)) {
          errors.push(
            `services[${i}] cannot override "${key}". Overridable: ${OVERRIDABLE.join(', ')}`
          )
        }
      }
      if (rule.metrics !== undefined) {
        if (!Array.isArray(rule.metrics) || rule.metrics.length === 0) {
          errors.push(`services[${i}].metrics must be a non-empty array`)
        } else if (
          Number.isFinite(rule.minSignals ?? config.detector?.minSignals) &&
          (rule.minSignals ?? config.detector.minSignals) > rule.metrics.length
        ) {
          errors.push(
            `services[${i}] minSignals exceeds its own metrics count (${rule.metrics.length})`
          )
        }
      }
      for (const key of ['zThreshold', 'triggerThreshold', 'criticalityWeight', 'sigmaFloorRatio']) {
        if (rule[key] !== undefined && (typeof rule[key] !== 'number' || !Number.isFinite(rule[key]))) {
          errors.push(`services[${i}].${key} must be a finite number`)
        }
      }
      for (const key of ['minSustain', 'minSignals', 'baselineWindows']) {
        if (rule[key] !== undefined && (!Number.isInteger(rule[key]) || rule[key] < 1)) {
          errors.push(`services[${i}].${key} must be an integer >= 1`)
        }
      }
    })
  }

  if (!Array.isArray(config.silences)) {
    errors.push('silences must be an array of maintenance-window rules')
  } else {
    config.silences.forEach((silence, i) => {
      for (const problem of validateSilence(silence)) {
        errors.push(`silences[${i}] ${problem}`)
      }
    })
  }

  if (errors.length) {
    throw new Error(`Invalid FAULTLINE configuration:\n  - ${errors.join('\n  - ')}`)
  }

  return config
}

function applyEnvOverrides(config, env) {
  const out = structuredClone(config)
  const num = (raw) => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  if (env.FAULTLINE_PORT !== undefined) out.server.port = num(env.FAULTLINE_PORT) ?? out.server.port
  if (env.FAULTLINE_HOST) out.server.host = env.FAULTLINE_HOST
  if (env.FAULTLINE_LOG_LEVEL) out.logging.level = env.FAULTLINE_LOG_LEVEL
  if (env.FAULTLINE_LOG_PRETTY !== undefined) out.logging.pretty = env.FAULTLINE_LOG_PRETTY === 'true'
  if (env.FAULTLINE_INTERVAL_SECONDS !== undefined) {
    out.detector.intervalSeconds = num(env.FAULTLINE_INTERVAL_SECONDS) ?? out.detector.intervalSeconds
  }
  if (env.FAULTLINE_STORAGE_PATH) out.storage.path = env.FAULTLINE_STORAGE_PATH
  if (env.FAULTLINE_SOURCE_TYPE) out.source.type = env.FAULTLINE_SOURCE_TYPE

  // A webhook URL is a secret: it is supplied by environment, never committed.
  if (env.FAULTLINE_WEBHOOK_URL) {
    const existing = out.alerting.notifiers.find((n) => n.type === 'webhook')
    if (existing) existing.url = env.FAULTLINE_WEBHOOK_URL
    else out.alerting.notifiers.push({ type: 'webhook', url: env.FAULTLINE_WEBHOOK_URL })
  }

  return out
}

export function loadConfig({ path, env = process.env, overrides = {} } = {}) {
  let fileConfig = {}
  let resolvedPath = null

  if (path) {
    resolvedPath = resolve(path)
    let contents
    try {
      contents = readFileSync(resolvedPath, 'utf8')
    } catch (err) {
      throw new Error(`Cannot read config file at ${resolvedPath}: ${err.message}`)
    }
    try {
      fileConfig = JSON.parse(contents)
    } catch (err) {
      throw new Error(`Config file at ${resolvedPath} is not valid JSON: ${err.message}`)
    }
  }

  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), overrides)
  const withEnv = applyEnvOverrides(merged, env)
  validateConfig(withEnv)
  return { ...withEnv, configPath: resolvedPath }
}

export function detectorParams(config) {
  const d = config.detector
  return {
    baselineWindows: d.baselineWindows,
    zThreshold: d.zThreshold,
    minSustain: d.minSustain,
    minSignals: d.minSignals,
    metrics: d.metrics,
    sigmaFloorRatio: d.sigmaFloorRatio,
    sigmaFloorAbs: d.sigmaFloorAbs ?? undefined,
    criticalityWeight: d.criticalityWeight,
    triggerThreshold: d.triggerThreshold,
    // The agent alerts on the trigger threshold; "outage" is a scenario-only
    // concept, so it is pinned above any reachable score here.
    outageThreshold: Number.POSITIVE_INFINITY,
  }
}
