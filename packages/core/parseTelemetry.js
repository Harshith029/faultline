const ALIASES = {
  window_number: ['window_number', 'window', 'w', 'step', 'index', 'n'],
  window_timestamp: ['window_timestamp', 'timestamp', 'time', 'ts', 'datetime'],
  p99_latency: ['p99_latency', 'p99', 'p99_latency_ms', 'latency', 'latency_ms', 'p99_ms'],
  retry_rate: ['retry_rate', 'retry', 'retries', 'retry_rate_pct', 'retry_pct'],
  error_rate: ['error_rate', 'error', 'errors', 'error_rate_pct', 'error_pct', 'err_rate'],
}

const DEFAULT_METRICS = ['p99_latency', 'retry_rate', 'error_rate']
const MIN_ROWS = 5

// The parser runs in the user's browser tab. Past this it is refused rather
// than left to stall the page: about 200,000 rows of four columns.
const MAX_INPUT_CHARS = 5_000_000
// Skip reasons quote the offending cell back; a pasted multi-megabyte cell
// must not be.
const MAX_QUOTED_CELL_CHARS = 40

// A plain decimal or scientific-notation number and nothing else. parseFloat
// reads "12x" as 12 and "1,234" as 1, and Number('') is 0: each would turn a
// typo or a blank cell into a measurement the engine then scores.
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** The cell as a number, or why it cannot be one. */
const readNumber = (cell) => {
  const text = String(cell ?? '').trim()
  if (text === '') return { problem: 'empty' }
  if (!NUMBER.test(text)) return { problem: 'not_a_number' }
  const value = Number(text)
  // "1e999" matches the pattern and is Infinity — not a measurement either.
  if (!Number.isFinite(value)) return { problem: 'out_of_range' }
  return { value }
}

const describeCell = (cell) => {
  const text = String(cell ?? '').trim()
  return text.length > MAX_QUOTED_CELL_CHARS ? `${text.slice(0, MAX_QUOTED_CELL_CHARS)}…` : text
}

const PROBLEMS = {
  empty: (name) => `${name} is empty`,
  not_a_number: (name, cell) => `${name} is "${describeCell(cell)}", which is not a number`,
  out_of_range: (name, cell) => `${name} is "${describeCell(cell)}", which is too large to be a measurement`,
}

/**
 * Splits CSV text into records, following RFC 4180: a field may be wrapped in
 * double quotes, and a quoted field may contain the delimiter, line breaks and
 * doubled quotes (""). Lines whose first non-space character is # are
 * comments, and blank lines are skipped. Each record carries the 1-based line
 * it starts on, so errors can point at the input.
 */
export function parseCsvRecords(text, delimiter = ',') {
  const records = []
  let cells = []
  let cell = ''
  // Whether the cell has had anything but spaces. Tracked as it grows: asking
  // `cell.trim()` at every quote made a quote-heavy cell quadratic.
  let cellStarted = false
  let quoted = false
  let line = 1
  let recordLine = 1
  let atRecordStart = true

  const endCell = () => {
    cells.push(cell)
    cell = ''
    cellStarted = false
  }

  const endRecord = () => {
    endCell()
    const blank = cells.length === 1 && cells[0].trim() === ''
    if (!blank) records.push({ line: recordLine, cells })
    cells = []
    atRecordStart = true
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }

    if (atRecordStart) {
      recordLine = line
      const end = text.indexOf('\n', i)
      const physicalLine = text.slice(i, end === -1 ? text.length : end)
      if (/^\s*#/.test(physicalLine)) {
        // Jump to the newline; the loop steps past it.
        i = end === -1 ? text.length : end
        line++
        continue
      }
      atRecordStart = false
    }

    if (ch === '"' && !cellStarted) {
      // Opens a quoted field. Once it closes, a later quote in the same cell
      // is ordinary text.
      quoted = true
      cell = ''
      cellStarted = true
    } else if (ch === delimiter) {
      endCell()
    } else if (ch === '\n') {
      endRecord()
      line++
    } else if (ch !== '\r') {
      cell += ch
      if (ch !== ' ' && ch !== '\t') cellStarted = true
    }
  }

  if (quoted) throw new Error(`line ${recordLine}: a quoted field is opened but never closed with a matching quote`)
  if (!atRecordStart) endRecord()
  return records
}

function resolveColumns(headerCells, metrics) {
  const normalized = headerCells.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  const map = {}

  for (const field of ['window_number', 'window_timestamp']) {
    const idx = normalized.findIndex((h) => ALIASES[field].includes(h))
    if (idx !== -1) map[field] = idx
  }

  // Known metrics match their aliases; anything else matches its exact column.
  for (const metric of metrics) {
    const accepted = ALIASES[metric] ?? [metric.toLowerCase()]
    const idx = normalized.findIndex((h) => accepted.includes(h))
    if (idx !== -1) map[metric] = idx
  }

  return map
}

/** Every configured metric of a row as a number, or the reason it cannot be used. */
function readMetrics(cells, cols, metrics) {
  const values = {}
  for (const metric of metrics) {
    const cell = cells[cols[metric]]
    const { value, problem } = readNumber(cell)
    if (problem) return { reason: PROBLEMS[problem](metric, cell) }
    values[metric] = value
  }
  return { values }
}

/**
 * Parses pasted or uploaded telemetry into engine windows.
 *
 * The accepted format is deliberately strict: a header row naming the metric
 * columns (common aliases accepted), then one row per window in time order.
 * Cells must be plain numbers. A row with a missing or malformed value is
 * skipped and reported in `skipped` with its line and the reason — never read
 * as a partial number or as zero. Window numbers come from a window column if
 * there is one (whole numbers, strictly increasing), otherwise from each row's
 * position, so a skipped row leaves a visible hole rather than making its
 * neighbours look adjacent.
 */
export function parseTelemetryCsv(text, { metrics = DEFAULT_METRICS } = {}) {
  if (!text || !text.trim()) {
    return { raw: null, error: 'Paste some CSV telemetry or load the example.', skipped: [] }
  }
  if (text.length > MAX_INPUT_CHARS) {
    return {
      raw: null,
      error: 'The CSV is larger than 5 MB. Trim it to the window you want to examine; analysis runs in this browser tab.',
      skipped: [],
    }
  }

  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '' && !/^\s*#/.test(l)) ?? ''
  const delimiter = firstLine.includes('\t') ? '\t' : ','

  let records
  try {
    records = parseCsvRecords(text, delimiter)
  } catch (err) {
    return { raw: null, error: `Could not read the CSV: ${err.message}.`, skipped: [] }
  }

  if (records.length < 2) {
    return { raw: null, error: 'Need a header row plus at least one data row.', skipped: [] }
  }

  const [header, ...rows] = records
  const cols = resolveColumns(header.cells, metrics)

  const missing = metrics.filter((m) => !(m in cols))
  if (missing.length) {
    return {
      raw: null,
      error: `Missing required column(s): ${missing.join(', ')}. Expected headers like: ${metrics.join(', ')}.`,
      skipped: [],
    }
  }

  const raw = []
  const skipped = []
  let previousWindow = null

  for (let index = 0; index < rows.length; index++) {
    const { line, cells } = rows[index]
    const { values, reason } = readMetrics(cells, cols, metrics)
    if (reason) {
      skipped.push({ line, reason })
      continue
    }

    // The row's position in the file, so a skipped row leaves a hole.
    let windowNumber = index + 1
    if ('window_number' in cols) {
      const cell = cells[cols.window_number]
      const { value } = readNumber(cell)
      if (!Number.isInteger(value)) {
        skipped.push({ line, reason: `window is "${describeCell(cell)}", which is not a whole number` })
        continue
      }
      windowNumber = value
    }

    if (previousWindow !== null && windowNumber <= previousWindow) {
      return {
        raw: null,
        error:
          `line ${line}: window ${windowNumber} does not come after window ${previousWindow}. ` +
          'Rows must be in time order, one row per window.',
        skipped,
      }
    }
    previousWindow = windowNumber

    const timestamp = 'window_timestamp' in cols ? describeCell(cells[cols.window_timestamp]) : ''
    raw.push({
      service_id: 'uploaded',
      window_number: windowNumber,
      window_timestamp: timestamp === '' ? undefined : timestamp,
      ...values,
    })
  }

  if (raw.length < MIN_ROWS) {
    const note = skipped.length ? ` (${skipped.length} skipped)` : ''
    return {
      raw: null,
      error: `Parsed only ${raw.length} valid row(s)${note}. Need at least ${MIN_ROWS} windows (the first few establish the baseline).`,
      skipped,
    }
  }

  return { raw, error: null, rowCount: raw.length, skipped }
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
