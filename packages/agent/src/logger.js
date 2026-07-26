const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const format = (value) =>
  value === null || typeof value !== 'object' ? String(value) : JSON.stringify(value)

export function createLogger({ level = 'info', pretty = false, stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  const emit = (lvl, event, fields = {}) => {
    if (LEVELS[lvl] < threshold) return
    const ts = new Date().toISOString()
    if (pretty) {
      const rest = Object.entries(fields)
        .map(([k, v]) => `${k}=${format(v)}`)
        .join(' ')
      stream.write(`${ts} ${lvl.toUpperCase().padEnd(5)} ${event}${rest ? ' ' + rest : ''}\n`)
    } else {
      stream.write(JSON.stringify({ ts, level: lvl, event, ...fields }) + '\n')
    }
  }

  return {
    level,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}

export const silentLogger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
}
