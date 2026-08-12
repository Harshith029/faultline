#!/usr/bin/env node
/**
 * Validates the SAM template with cfn-lint.
 *
 * cfn-lint is a Python tool, and its console script is frequently not on PATH:
 * pip installs it against one interpreter while the active shell resolves
 * `python` to another (a virtualenv, the Windows Store shim, a tool-managed
 * runtime). That makes "cfn-lint is unavailable" a common false conclusion —
 * the package is installed, just not reachable the way it was invoked.
 *
 * So rather than assuming one invocation, this tries each candidate in turn and
 * reports which one worked. It exits non-zero on findings, and separately
 * non-zero with an explicit UNAVAILABLE message if no interpreter has cfn-lint,
 * so "not installed" is never mistaken for "no findings".
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const template = resolve(root, 'backend/lambda/timelineHandler/template.yaml')

// Emits one line per finding, then a count. Using the API avoids depending on
// the console script being installed and on PATH.
const PROGRAM = `
import sys
from cfnlint import api
matches = api.lint_all(open(sys.argv[1], encoding='utf-8').read())
for m in matches:
    print(m)
print('FINDINGS', len(matches))
`

const candidates = [
  process.env.CFN_LINT_PYTHON,
  'python',
  'python3',
  'py',
  // Where pip commonly lands on Windows when the shell resolves elsewhere.
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Python\\Python311\\python.exe`,
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Python\\Python312\\python.exe`,
].filter(Boolean)

const tried = []

for (const python of candidates) {
  const probe = spawnSync(python, ['-c', 'import cfnlint'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    tried.push(`${python}: ${probe.error ? probe.error.code : 'no cfnlint module'}`)
    continue
  }

  console.log(`cfn-lint via ${python}`)
  const run = spawnSync(python, ['-c', PROGRAM, template], { encoding: 'utf8' })
  const output = (run.stdout ?? '').trim()

  if (run.status !== 0 && !output) {
    console.error(run.stderr ?? 'cfn-lint failed with no output')
    process.exit(1)
  }

  const lines = output.split(/\r?\n/)
  const countLine = lines.pop() ?? ''
  const findings = Number(countLine.replace('FINDINGS', '').trim())

  if (!Number.isFinite(findings)) {
    console.error('cfn-lint produced unparseable output:')
    console.error(output)
    process.exit(1)
  }

  if (findings === 0) {
    console.log('0 findings.')
    process.exit(0)
  }

  for (const line of lines) console.error(line)
  console.error(`${findings} finding(s).`)
  process.exit(1)
}

console.error('UNAVAILABLE: no Python interpreter with cfn-lint was found. This is not a pass.')
console.error('Install it with:  pip install cfn-lint')
console.error('Or point at the right interpreter:  CFN_LINT_PYTHON=/path/to/python npm run lint:iac')
console.error('Tried:')
for (const line of tried) console.error(`  ${line}`)
process.exit(1)
