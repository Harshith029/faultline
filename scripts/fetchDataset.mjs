import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'

const SMD_BASE =
  'https://raw.githubusercontent.com/NetManAIOps/OmniAnomaly/master/ServerMachineDataset'

const DEFAULT_MACHINES = ['machine-1-1', 'machine-1-2', 'machine-2-1', 'machine-3-2']

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Downloads the Server Machine Dataset on demand.
 *
 * The data is deliberately NOT vendored into this repository: it belongs to the
 * OmniAnomaly authors (NetManAIOps) and is fetched into a gitignored directory
 * so the licence and provenance stay with them.
 */
async function main() {
  const args = process.argv.slice(2)
  const machinesArg = args.find((a) => a.startsWith('--machines='))
  const machines = machinesArg ? machinesArg.split('=')[1].split(',') : DEFAULT_MACHINES
  const dir = join(process.cwd(), 'data', 'datasets', 'smd')
  await mkdir(dir, { recursive: true })

  for (const machine of machines) {
    for (const kind of ['test', 'test_label']) {
      const target = join(dir, `${kind}_${machine}.txt`)
      if (await exists(target)) {
        process.stdout.write(`skip   ${kind}/${machine} (already present)\n`)
        continue
      }
      const url = `${SMD_BASE}/${kind}/${machine}.txt`
      process.stdout.write(`fetch  ${url}\n`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`)
      await writeFile(target, Buffer.from(await res.arrayBuffer()))
    }
  }

  process.stdout.write(`\nDataset ready in ${dir}\n`)
  process.stdout.write('Source: Server Machine Dataset, NetManAIOps/OmniAnomaly (MIT).\n')
  process.stdout.write('Run:    npm run backtest\n')
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`)
  process.exit(1)
})
