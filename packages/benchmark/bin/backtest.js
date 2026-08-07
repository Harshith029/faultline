#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { availableMachines, loadMachine, loadTrainMachine, SMD_DIR } from '../src/datasets/smd.js'
import { backtestMachine, learnThresholds, smdParams } from '../src/backtest.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`))
  return found ? found.split('=')[1] : fallback
}

const asJson = args.includes('--json')
const sweep = args.includes('--sweep')
const aggregate = Number(arg('aggregate', 5))
const historyWindows = Number(arg('history', 120))
const only = arg('machine', null)
const paramOverrides = {}
if (arg('minSignals', null)) paramOverrides.minSignals = Number(arg('minSignals'))
if (arg('trigger', null)) paramOverrides.triggerThreshold = Number(arg('trigger'))
if (arg('minSustain', null)) paramOverrides.minSustain = Number(arg('minSustain'))

const machines = only ? [only] : availableMachines()

if (machines.length === 0) {
  process.stderr.write(
    'No SMD data found.\n\nDownload it first (it is not vendored in this repo):\n  npm run fetch:dataset\n'
  )
  process.exit(1)
}

const DETECTOR_LABELS = {
  faultline: 'FAULTLINE',
  faultline_learned: 'FAULTLINE +learned',
  single_3sigma: 'Single metric 3σ',
  sustained_3sigma: 'Sustained 3σ',
}

const datasets = machines.map((machine) => loadMachine(machine, { aggregate }))

// Per-channel thresholds are learned from each machine's own anomaly-free
// training split. Test labels are never consulted.
const thresholdsByMachine = {}
for (const dataset of datasets) {
  if (!existsSync(join(SMD_DIR, `train_${dataset.machine}.txt`))) continue
  const train = loadTrainMachine(dataset.machine, { aggregate })
  thresholdsByMachine[dataset.machine] = learnThresholds(train.windows, {
    metrics: dataset.metrics,
    params: smdParams(dataset.metrics, paramOverrides),
    historyWindows,
  })
}

if (sweep) {
  const grid = []
  for (const minSignals of [2, 4, 6, 8, 12]) {
    for (const triggerThreshold of [3, 5, 8]) {
      grid.push({ minSignals, triggerThreshold })
    }
  }

  process.stdout.write(`\nParameter sweep — FAULTLINE on ${datasets.length} machine(s), ${datasets[0].metrics.length} channels\n`)
  process.stdout.write(`${'='.repeat(72)}\n`)
  process.stdout.write(`minSignals  trigger  precision  recall   F1       false alerts\n`)
  process.stdout.write(`${'-'.repeat(72)}\n`)

  for (const combo of grid) {
    let segments = 0
    let detected = 0
    let episodes = 0
    let fp = 0
    for (const dataset of datasets) {
      const { results } = backtestMachine(dataset, { historyWindows, paramOverrides: combo })
      segments += results.faultline.segments
      detected += results.faultline.detectedSegments
      episodes += results.faultline.episodes
      fp += results.faultline.falsePositiveEpisodes
    }
    const recall = segments ? detected / segments : 0
    const precision = episodes ? (episodes - fp) / episodes : 0
    const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0
    process.stdout.write(
      `${String(combo.minSignals).padEnd(12)}${String(combo.triggerThreshold).padEnd(9)}` +
        `${`${(precision * 100).toFixed(1)}%`.padEnd(11)}${`${(recall * 100).toFixed(1)}%`.padEnd(9)}` +
        `${`${(f1 * 100).toFixed(1)}%`.padEnd(9)}${fp}\n`
    )
  }
  process.stdout.write('\n')
  process.exit(0)
}

const runs = datasets.map((dataset) => ({
  ...backtestMachine(dataset, {
    historyWindows,
    paramOverrides,
    learnedThresholds: thresholdsByMachine[dataset.machine] ?? null,
  }),
  metrics: dataset.metrics.length,
}))

if (asJson) {
  process.stdout.write(JSON.stringify({ aggregate, historyWindows, runs }, null, 2) + '\n')
  process.exit(0)
}

const pct = (x) => (x === null ? '   -  ' : `${(x * 100).toFixed(1)}%`.padStart(6))
const pad = (s, n) => String(s).padEnd(n)

process.stdout.write(`\nBacktest — Server Machine Dataset (real production telemetry)\n`)
process.stdout.write(`${'='.repeat(88)}\n`)
process.stdout.write(
  `${runs.length} machine(s), ${runs[0].metrics} channels each, ${aggregate}-sample windows, ${historyWindows}-window rolling history\n`
)
process.stdout.write(`Segment-wise scoring: an incident is caught if the detector fires inside it;\n`)
process.stdout.write(`a contiguous run of firing outside any incident is one false positive.\n\n`)

for (const run of runs) {
  process.stdout.write(`${run.machine}  (${run.windows} windows, ${run.results.faultline.segments} labelled incidents)\n`)
  process.stdout.write(
    `  ${pad('detector', 20)}${pad('precision', 11)}${pad('recall', 11)}${pad('F1', 11)}${pad('alerts', 9)}${pad('false alerts', 14)}${pad('delay', 8)}\n`
  )
  process.stdout.write(`  ${'-'.repeat(84)}\n`)
  for (const [key, label] of Object.entries(DETECTOR_LABELS)) {
    const r = run.results[key]
    if (!r) continue
    process.stdout.write(
      `  ${pad(label, 20)}${pad(pct(r.precision), 11)}${pad(pct(r.recall), 11)}${pad(pct(r.f1), 11)}` +
        `${pad(r.episodes, 9)}${pad(r.falsePositiveEpisodes, 14)}` +
        `${pad(r.medianDelayWindows === null ? '-' : `+${r.medianDelayWindows}w`, 8)}\n`
    )
  }
  process.stdout.write('\n')
}

if (runs.length > 1) {
  process.stdout.write(`Aggregate across ${runs.length} machines\n`)
  process.stdout.write(`  ${pad('detector', 20)}${pad('precision', 11)}${pad('recall', 11)}${pad('F1', 11)}${pad('false alerts', 14)}\n`)
  process.stdout.write(`  ${'-'.repeat(84)}\n`)
  for (const [key, label] of Object.entries(DETECTOR_LABELS)) {
    if (!runs.every((r) => r.results[key])) continue
    const segments = runs.reduce((a, r) => a + r.results[key].segments, 0)
    const detected = runs.reduce((a, r) => a + r.results[key].detectedSegments, 0)
    const episodes = runs.reduce((a, r) => a + r.results[key].episodes, 0)
    const fp = runs.reduce((a, r) => a + r.results[key].falsePositiveEpisodes, 0)
    const recall = segments ? detected / segments : null
    const precision = episodes ? (episodes - fp) / episodes : null
    const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0
    process.stdout.write(
      `  ${pad(label, 20)}${pad(pct(precision), 11)}${pad(pct(recall), 11)}${pad(pct(f1), 11)}${pad(fp, 14)}\n`
    )
  }
  process.stdout.write('\n')
}
