#!/usr/bin/env node
/**
 * Builds the Lambda deployment artifact from source.
 *
 * The point is reproducibility: the previous artifact was a gitignored local
 * zip that had drifted older and smaller than the handler it was supposed to
 * contain, so nobody could tell what was actually deployed. This script always
 * builds from a clean production install and prints a digest, so the artifact
 * is verifiable rather than assumed.
 *
 * Usage:  npm run package  [-- --out dist/function.zip]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, existsSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const outPath = resolve(root, argOf('--out', 'dist/function.zip'))
const stageDir = resolve(root, 'dist/stage')

// `npm` and `powershell` are resolved through the shell on Windows, but an
// absolute executable path must not be — a shell would split "C:\Program Files".
const run = (cmd, args, cwd, { useShell = process.platform === 'win32' } = {}) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell })

console.log('› cleaning previous artifact')
rmSync(resolve(root, 'dist'), { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
mkdirSync(dirname(outPath), { recursive: true })

console.log('› staging source')
for (const file of ['handler.js', 'package.json', 'package-lock.json']) {
  cpSync(join(root, file), join(stageDir, file))
}

console.log('› installing production dependencies')
run('npm', ['ci', '--omit=dev', '--ignore-scripts'], stageDir)

// The lockfile is an input to the build, not part of the runtime artifact.
rmSync(join(stageDir, 'package-lock.json'), { force: true })

console.log('› creating zip')
if (process.platform === 'win32') {
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${outPath}' -Force`,
  ])
} else {
  run('zip', ['-qr', outPath, '.'], stageDir)
}

if (!existsSync(outPath)) {
  console.error('packaging failed: no artifact produced')
  process.exit(1)
}

const bytes = statSync(outPath).size
const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex')

// A handler that cannot be imported must never reach an artifact.
console.log('› verifying handler imports from the staged tree')
run(
  process.execPath,
  ['-e', "import('./handler.js').then(m => { if (typeof m.handler !== 'function') { throw new Error('handler export missing') } })"],
  stageDir,
  { useShell: false }
)

console.log('')
console.log(`artifact : ${outPath}`)
console.log(`bytes    : ${bytes}`)
console.log(`sha256   : ${sha256}`)
