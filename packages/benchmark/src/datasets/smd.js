import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const SMD_DIR = join(process.cwd(), 'data', 'datasets', 'smd')

export function availableMachines(dir = SMD_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith('test_') && !f.startsWith('test_label_'))
    .map((f) => f.replace(/^test_/, '').replace(/\.txt$/, ''))
    .filter((machine) => existsSync(join(dir, `test_label_${machine}.txt`)))
    .sort()
}

const readMatrix = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map(Number))

/**
 * Loads one machine and aggregates raw samples into detection windows.
 *
 * SMD is sampled once per minute. `aggregate` averages consecutive samples into
 * a single window, which mirrors how an agent with a longer collection interval
 * would see the same system, and keeps the rolling evaluation tractable.
 * A window is labelled anomalous if ANY sample inside it was labelled anomalous.
 */
export function loadMachine(machine, { dir = SMD_DIR, aggregate = 5 } = {}) {
  const dataPath = join(dir, `test_${machine}.txt`)
  const labelPath = join(dir, `test_label_${machine}.txt`)

  if (!existsSync(dataPath) || !existsSync(labelPath)) {
    throw new Error(
      `SMD machine "${machine}" not found in ${dir}. Run: npm run fetch:dataset`
    )
  }

  const rows = readMatrix(dataPath)
  const labels = readFileSync(labelPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number)

  const channelCount = rows[0].length
  const metrics = Array.from({ length: channelCount }, (_, i) => `c${String(i).padStart(2, '0')}`)

  const windows = []
  const windowLabels = []

  for (let start = 0; start + aggregate <= rows.length; start += aggregate) {
    const window = {
      window_number: windows.length + 1,
      window_timestamp: new Date(Date.UTC(2026, 0, 1) + start * 60000).toISOString(),
    }
    for (let c = 0; c < channelCount; c++) {
      let sum = 0
      for (let k = 0; k < aggregate; k++) sum += rows[start + k][c]
      window[metrics[c]] = sum / aggregate
    }
    windows.push(window)

    let anomalous = 0
    for (let k = 0; k < aggregate; k++) anomalous |= labels[start + k] ?? 0
    windowLabels.push(anomalous)
  }

  return { machine, metrics, windows, labels: windowLabels, aggregate, rawSamples: rows.length }
}

/** Contiguous runs of anomalous windows, i.e. distinct incidents. */
export function labelSegments(labels) {
  const segments = []
  let start = null
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] && start === null) start = i
    if (!labels[i] && start !== null) {
      segments.push({ start, end: i - 1, length: i - start })
      start = null
    }
  }
  if (start !== null) segments.push({ start, end: labels.length - 1, length: labels.length - start })
  return segments
}
