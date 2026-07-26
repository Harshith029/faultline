import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runDetection } from '../packages/core/index.js'
import { RAW_TELEMETRY } from '../packages/core/index.js'

const FALLBACK_HYPOTHESIS = {
  root_service: 'service-b',
  mechanism:
    'Connection pool exhaustion under a sustained retry storm caused cascading thread starvation across dependent services',
  cascade_path: 'service-b → service-d → service-f',
  evidence: [
    'p99 latency crossed 2σ at W5 and qualified at W6 after sustaining across consecutive windows, indicating persistent resource contention',
    'retry rate crossed threshold at W7 and qualified at W8 at 3.4σ — consistent with client-side backoff amplification',
    'error rate qualified at W9 and breached the 2% SLO at W11, confirming downstream propagation three windows after detection',
  ],
}

const { windows } = runDetection(RAW_TELEMETRY)

const dataset = windows.map((w) => {
  const record = {
    service_id: 'B',
    window_timestamp: w.window_timestamp,
    window_number: w.window_number,
    metrics: w.metrics,
    qualified_signals: w.qualified_signals,
    signal_count: w.signal_count,
    R_score: w.R_score,
    confidence: w.confidence,
    triggered: w.triggered,
    outage: w.outage,
  }
  if (w.triggered) {
    record.hypothesis_fallback = FALLBACK_HYPOTHESIS
  }
  return record
})

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dataset', 'faultline_windows.json')
writeFileSync(outPath, JSON.stringify(dataset, null, 2) + '\n')
console.log(`Wrote ${dataset.length} windows to ${outPath}`)
console.log(`Trigger: W${dataset.find((w) => w.triggered)?.window_number}  Outage: W${dataset.find((w) => w.outage)?.window_number}`)
