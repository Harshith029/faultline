const escapeRegex = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

export const globToRegExp = (pattern) =>
  new RegExp(`^${escapeRegex(pattern).replace(/\*/g, '.*')}$`)

export const OVERRIDABLE = [
  'metrics',
  'zThreshold',
  'zThresholdPerMetric',
  'minSustain',
  'minSignals',
  'triggerThreshold',
  'criticalityWeight',
  'sigmaFloorRatio',
  'sigmaFloorAbs',
  'baselineWindows',
  'statistic',
]

/**
 * Compiles the `services` config block into ordered match rules.
 *
 * A real fleet is not homogeneous: a checkout API and a nightly batch worker
 * should not share a threshold, and `criticalityWeight` only means anything if
 * it can differ per service. Each rule overrides any detector parameter for the
 * services it matches; everything unspecified falls through to the global
 * detector config.
 */
export function compileServiceRules(services = []) {
  return services.map((rule, index) => {
    const overrides = {}
    for (const key of OVERRIDABLE) {
      if (rule[key] !== undefined) overrides[key] = rule[key]
    }
    return {
      index,
      match: rule.match,
      name: rule.name ?? rule.match,
      isPattern: rule.match.includes('*'),
      regex: globToRegExp(rule.match),
      overrides,
    }
  })
}

/**
 * Resolution order is deliberate and predictable: an exact name match always
 * wins over a wildcard, and among wildcards the first declared rule wins. That
 * way adding a broad `*` catch-all can never silently override a specific
 * service someone configured earlier.
 */
export function matchRule(service, rules) {
  const exact = rules.find((r) => !r.isPattern && r.match === service)
  if (exact) return exact
  return rules.find((r) => r.isPattern && r.regex.test(service)) ?? null
}

const VALID_STATISTICS = ['mean_sigma', 'median_mad']

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Validates the *effective* detector profile for a service rule.
 *
 * Validating overrides field by field is not enough, because the failures that
 * matter are cross-field. `baselineWindows: 40` is a fine number on its own; it
 * is only fatal once combined with a 40-window history and a sustain
 * requirement, at which point the detector needs 42 windows it can never hold
 * and sits in `warming_up` forever — silently, because warming up is a normal
 * state. The only way to catch that is to resolve the whole profile and check
 * it as a unit.
 *
 * `label` identifies the profile in error messages.
 */
export function validateEffectiveProfile(effective, { historyWindows, label }) {
  const errors = []
  const at = (msg) => errors.push(`${label} ${msg}`)

  const metrics = effective.metrics
  if (!Array.isArray(metrics) || metrics.length === 0) {
    at('resolves to an empty metric list')
    return errors
  }
  if (metrics.some((m) => typeof m !== 'string' || m.trim() === '')) {
    at('has metric names that are not non-empty strings')
  }
  if (new Set(metrics).size !== metrics.length) {
    at('has duplicate metric names')
  }

  const ints = {
    baselineWindows: { min: 2 },
    minSustain: { min: 1 },
    minSignals: { min: 1 },
  }
  for (const [key, rule] of Object.entries(ints)) {
    const value = effective[key]
    if (!Number.isInteger(value) || value < rule.min) {
      at(`resolves ${key} to ${JSON.stringify(value)}; it must be an integer >= ${rule.min}`)
    }
  }

  const nonNegative = ['zThreshold', 'triggerThreshold', 'criticalityWeight', 'sigmaFloorRatio']
  for (const key of nonNegative) {
    const value = effective[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      at(`resolves ${key} to ${JSON.stringify(value)}; it must be a finite number >= 0`)
    }
  }

  if (Number.isInteger(effective.minSignals) && effective.minSignals > metrics.length) {
    at(
      `requires ${effective.minSignals} converging signals but only ${metrics.length} metric(s) are configured ` +
        `(${metrics.join(', ')}); it can never trigger`
    )
  }

  if (
    Number.isInteger(effective.baselineWindows) &&
    Number.isInteger(effective.minSustain) &&
    Number.isFinite(historyWindows)
  ) {
    const required = effective.baselineWindows + effective.minSustain
    if (required > historyWindows) {
      at(
        `needs ${required} windows (baselineWindows ${effective.baselineWindows} + minSustain ` +
          `${effective.minSustain}) but detector.historyWindows is ${historyWindows}; it would stay in ` +
          'warming_up forever'
      )
    }
  }

  if (effective.statistic !== undefined && !VALID_STATISTICS.includes(effective.statistic)) {
    at(`resolves statistic to ${JSON.stringify(effective.statistic)}; expected one of ${VALID_STATISTICS.join(', ')}`)
  }

  if (effective.zThresholdPerMetric !== undefined) {
    if (!isPlainObject(effective.zThresholdPerMetric)) {
      at('zThresholdPerMetric must be an object of metric -> threshold')
    } else {
      for (const [metric, value] of Object.entries(effective.zThresholdPerMetric)) {
        if (!metrics.includes(metric)) {
          at(`sets zThresholdPerMetric for "${metric}", which is not in its metric list`)
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          at(`sets zThresholdPerMetric["${metric}"] to ${JSON.stringify(value)}; expected a finite number >= 0`)
        }
      }
    }
  }

  if (effective.sigmaFloorAbs != null) {
    if (!isPlainObject(effective.sigmaFloorAbs)) {
      at('sigmaFloorAbs must be an object of metric -> minimum sigma, or null')
    } else {
      for (const [metric, value] of Object.entries(effective.sigmaFloorAbs)) {
        if (!metrics.includes(metric)) {
          at(`sets sigmaFloorAbs for "${metric}", which is not in its metric list`)
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          at(`sets sigmaFloorAbs["${metric}"] to ${JSON.stringify(value)}; expected a finite number >= 0`)
        }
      }
    }
  }

  return errors
}

/**
 * Resolves and validates every profile a service could actually run under: the
 * global defaults, plus each declared override rule applied on top of them.
 */
export function validateAllProfiles(config, baseParams) {
  const historyWindows = config.detector?.historyWindows
  const errors = validateEffectiveProfile(baseParams, {
    historyWindows,
    label: 'The default detector profile',
  })

  for (const [i, rule] of (config.services ?? []).entries()) {
    if (typeof rule?.match !== 'string') continue
    const overrides = {}
    for (const key of OVERRIDABLE) {
      if (rule[key] !== undefined) overrides[key] = rule[key]
    }
    errors.push(
      ...validateEffectiveProfile(
        { ...baseParams, ...overrides },
        { historyWindows, label: `services[${i}] ("${rule.match}")` }
      )
    )
  }

  return errors
}

export function createParamsResolver(baseParams, rules) {
  const cache = new Map()

  return (service) => {
    const cached = cache.get(service)
    if (cached) return cached

    const rule = matchRule(service, rules)
    const params = rule ? { ...baseParams, ...rule.overrides } : baseParams
    const resolved = { params, profile: rule?.name ?? null }
    cache.set(service, resolved)
    return resolved
  }
}
