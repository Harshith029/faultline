const ALIASES = {
  window_number: ['window_number', 'window', 'w', 'step', 'index', 'n'],
  window_timestamp: ['window_timestamp', 'timestamp', 'time', 'ts', 'datetime'],
  p99_latency: ['p99_latency', 'p99', 'p99_latency_ms', 'latency', 'latency_ms', 'p99_ms'],
  retry_rate: ['retry_rate', 'retry', 'retries', 'retry_rate_pct', 'retry_pct'],
  error_rate: ['error_rate', 'error', 'errors', 'error_rate_pct', 'error_pct', 'err_rate'],
}

const REQUIRED_METRICS = ['p99_latency', 'retry_rate', 'error_rate']

function resolveColumns(headerCells) {
  const normalized = headerCells.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const map = {}
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h))
    if (idx !== -1) map[canonical] = idx
  }
  return map
}

export function parseTelemetryCsv(text) {
  if (!text || !text.trim()) {
    return { raw: null, error: 'Paste some CSV telemetry or load the example.' }
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  if (lines.length < 2) {
    return { raw: null, error: 'Need a header row plus at least one data row.' }
  }

  const delimiter = lines[0].includes('\t') ? '\t' : ','
  const header = lines[0].split(delimiter)
  const cols = resolveColumns(header)

  const missing = REQUIRED_METRICS.filter((m) => !(m in cols))
  if (missing.length) {
    return {
      raw: null,
      error: `Missing required column(s): ${missing.join(', ')}. Expected headers like: p99_latency, retry_rate, error_rate.`,
    }
  }

  const raw = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter)
    const num = (key) => {
      const v = parseFloat(cells[cols[key]])
      return Number.isFinite(v) ? v : null
    }
    const p99 = num('p99_latency')
    const retry = num('retry_rate')
    const error = num('error_rate')
    if (p99 === null || retry === null || error === null) continue

    raw.push({
      service_id: 'uploaded',
      window_number:
        'window_number' in cols && Number.isFinite(parseFloat(cells[cols.window_number]))
          ? parseInt(cells[cols.window_number], 10)
          : raw.length + 1,
      window_timestamp:
        'window_timestamp' in cols ? String(cells[cols.window_timestamp]).trim() : undefined,
      p99_latency: p99,
      retry_rate: retry,
      error_rate: error,
    })
  }

  if (raw.length < 5) {
    return {
      raw: null,
      error: `Parsed only ${raw.length} valid row(s). Need at least 5 windows (the first few establish the baseline).`,
    }
  }

  raw.forEach((r, i) => {
    if (!Number.isFinite(r.window_number)) r.window_number = i + 1
  })

  return { raw, error: null, rowCount: raw.length }
}

export const EXAMPLE_CSV = `window,p99_latency,retry_rate,error_rate
1,135,0.59,0.61
2,107,0.98,0.31
3,146,0.49,0.71
4,96,1.06,0.37
5,138,1.06,0.94
6,144,1.22,1.01
7,157,1.42,1.07
8,175,1.63,1.18
9,195,1.84,1.36
10,217,2.07,1.56
11,245,2.39,1.83
12,281,2.83,2.15`
