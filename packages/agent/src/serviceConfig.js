const escapeRegex = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const globToRegExp = (pattern) => new RegExp(`^${escapeRegex(pattern).replace(/\*/g, '.*')}$`)

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
