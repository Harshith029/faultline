#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { FaultlineAgent, VERSION } from '../src/agent.js'

const HELP = `
FAULTLINE agent v${VERSION} — continuous cascade-failure detection

Usage:
  faultline start [--config <path>] [options]
  faultline once  [--config <path>]
  faultline --help | --version

Commands:
  start           Run continuously: collect, detect, alert, serve the API.
  once            Run a single collection cycle and print the result as JSON.

Options:
  --config <path>     Path to a JSON config file (default: ./faultline.config.json if present)
  --source <type>     synthetic | prometheus | http | cloudwatch
  --interval <sec>    Seconds between collection cycles
  --port <port>       HTTP API port (0 disables a fixed port)
  --no-server         Do not start the HTTP API
  --pretty            Human-readable logs instead of JSON
  --log-level <lvl>   debug | info | warn | error

Environment:
  FAULTLINE_WEBHOOK_URL   Alert webhook (Slack-compatible). Never commit this.
  FAULTLINE_PORT, FAULTLINE_HOST, FAULTLINE_LOG_LEVEL, FAULTLINE_INTERVAL_SECONDS,
  FAULTLINE_STORAGE_PATH, FAULTLINE_SOURCE_TYPE

Examples:
  faultline start --config faultline.demo.json --pretty
  FAULTLINE_WEBHOOK_URL=https://hooks.slack.com/... faultline start --config prod.json
`

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      args._.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (key === 'no-server' || key === 'pretty' || key === 'help' || key === 'version') {
      args[key] = true
    } else {
      args[key] = argv[++i]
    }
  }
  return args
}

function buildOverrides(args) {
  const overrides = {}
  if (args.source) overrides.source = { type: args.source }
  if (args.interval) overrides.detector = { intervalSeconds: Number(args.interval) }
  if (args.port) overrides.server = { ...(overrides.server ?? {}), port: Number(args.port) }
  if (args['no-server']) overrides.server = { ...(overrides.server ?? {}), enabled: false }
  if (args.pretty) overrides.logging = { ...(overrides.logging ?? {}), pretty: true }
  if (args['log-level']) overrides.logging = { ...(overrides.logging ?? {}), level: args['log-level'] }
  return overrides
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] ?? 'start'

  if (args.help || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const configPath = args.config ?? (existsSync('faultline.config.json') ? 'faultline.config.json' : undefined)

  let config
  try {
    config = loadConfig({ path: configPath, overrides: buildOverrides(args) })
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exitCode = 1
    return
  }

  const logger = createLogger(config.logging)

  if (command === 'once') {
    const agent = new FaultlineAgent({ ...config, server: { ...config.server, enabled: false } }, { logger })
    await agent.store.load()
    await agent.tick()
    process.stdout.write(JSON.stringify(agent.snapshot(), null, 2) + '\n')
    await agent.stop()
    return
  }

  if (command !== 'start') {
    process.stderr.write(`Unknown command "${command}".\n${HELP}`)
    process.exitCode = 1
    return
  }

  const agent = new FaultlineAgent(config, { logger })

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('agent.shutdown', { signal })
    try {
      await agent.stop()
      process.exit(0)
    } catch (err) {
      logger.error('agent.shutdown_failed', { message: err.message })
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    logger.error('agent.unhandled_rejection', { message: reason?.message ?? String(reason) })
  })

  await agent.start()
  // Keep the process alive: the tick timer is unref'd so it cannot hold the
  // loop open on its own, which keeps `once` and tests from hanging.
  setInterval(() => {}, 1 << 30)
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack ?? err.message}\n`)
  process.exit(1)
})
