import { createSyntheticSource } from './synthetic.js'
import { createPrometheusSource } from './prometheus.js'
import { createHttpSource } from './http.js'
import { createCloudWatchSource } from './cloudwatch.js'

const FACTORIES = {
  synthetic: createSyntheticSource,
  prometheus: createPrometheusSource,
  http: createHttpSource,
  cloudwatch: createCloudWatchSource,
}

export function createSource(config, ctx) {
  const factory = FACTORIES[config.type]
  if (!factory) {
    throw new Error(`Unknown source type "${config.type}". Available: ${Object.keys(FACTORIES).join(', ')}`)
  }
  return factory(config.options ?? {}, ctx)
}

export { createSyntheticSource, createPrometheusSource, createHttpSource, createCloudWatchSource }
