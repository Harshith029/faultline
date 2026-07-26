#!/usr/bin/env node
import { evaluate, leadTimeComparison } from '../src/evaluate.js'
import { DETECTORS } from '../src/detectors.js'

const args = process.argv.slice(2)
const seedsArg = args.find((a) => a.startsWith('--seeds='))
const seeds = seedsArg ? Number(seedsArg.split('=')[1]) : 20
const asJson = args.includes('--json')

const result = evaluate({ seeds })
const leads = leadTimeComparison({ seeds })

if (asJson) {
  process.stdout.write(JSON.stringify({ ...result, leadTime: leads }, null, 2) + '\n')
  process.exit(0)
}

const pct = (x) => (x === null ? '   -  ' : `${(x * 100).toFixed(1)}%`.padStart(6))
const pad = (s, n) => String(s).padEnd(n)

process.stdout.write(`\nFAULTLINE detection benchmark — ${result.scenarios.length} scenarios x ${seeds} seeds\n`)
process.stdout.write(`${'='.repeat(96)}\n\n`)

process.stdout.write(`Per-scenario fire rate (want 100% on "fire", 0% on "quiet")\n\n`)
process.stdout.write(`${pad('scenario', 28)}${pad('expect', 8)}`)
for (const d of DETECTORS) process.stdout.write(pad(d.label, 18))
process.stdout.write('\n')
process.stdout.write(`${'-'.repeat(96)}\n`)

for (let i = 0; i < result.scenarios.length; i++) {
  const scenario = result.scenarios[i]
  process.stdout.write(`${pad(scenario.name, 28)}${pad(scenario.expect, 8)}`)
  for (const d of DETECTORS) {
    const row = result.summary.find((s) => s.key === d.key).scenarios[i]
    const mark = row.correct ? ' ' : '!'
    const delay = row.medianDelay === null ? '' : ` +${row.medianDelay}w`
    process.stdout.write(pad(`${(row.fireRate * 100).toFixed(0)}%${delay}${mark}`, 18))
  }
  process.stdout.write('\n')
}

process.stdout.write(`\n\nOverall\n\n`)
process.stdout.write(`${pad('detector', 22)}${pad('precision', 11)}${pad('recall', 11)}${pad('F1', 11)}${pad('median delay', 14)}\n`)
process.stdout.write(`${'-'.repeat(96)}\n`)
for (const s of result.summary) {
  process.stdout.write(
    `${pad(s.label, 22)}${pad(pct(s.precision), 11)}${pad(pct(s.recall), 11)}${pad(pct(s.f1), 11)}` +
      `${pad(s.medianDetectionDelay === null ? '-' : `+${s.medianDetectionDelay} windows`, 14)}\n`
  )
}

process.stdout.write(`\n\nFAULTLINE lead time over each baseline (positive = FAULTLINE fired earlier)\n\n`)
for (const lead of leads) {
  process.stdout.write(
    `  ${pad(lead.label, 22)} median ${String(lead.medianLeadWindows).padStart(4)} windows   ` +
      `(earlier or tied on ${lead.wonOrTied}/${lead.samples} runs)\n`
  )
}

const failures = result.summary
  .find((s) => s.key === 'faultline')
  .scenarios.filter((s) => !s.correct)

if (failures.length) {
  process.stdout.write(`\n\nFAULTLINE deviations from label\n\n`)
  for (const f of failures) {
    const note = result.scenarios.find((s) => s.name === f.scenario).note
    process.stdout.write(`  ${f.scenario} (expected ${f.expect}, fired on ${f.firedRuns}/${f.totalRuns} runs)\n`)
    process.stdout.write(`    ${note}\n`)
  }
}

process.stdout.write('\n')
