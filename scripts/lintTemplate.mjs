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
 * reports which one worked. It exits non-zero on error or warning findings, and
 * separately non-zero with an explicit UNAVAILABLE message if no interpreter has
 * cfn-lint, so "not installed" is never mistaken for "no findings".
 *
 * Informational (I-series) findings are printed but do not fail the check —
 * the same default as cfn-lint's own CLI. CI installs the latest cfn-lint, and
 * new advisory rules ship regularly; letting each one break the build would
 * make the gate fail for reasons unrelated to the template's correctness.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const template = resolve(root, 'backend/lambda/timelineHandler/template.yaml')

// Emits one line per finding prefixed by its severity letter, then the total
// and blocking counts. A finding whose rule id cannot be read counts as
// blocking. Using the API avoids depending on the console script being
// installed and on PATH.
const PROGRAM = `
import sys
from cfnlint import api
matches = api.lint_all(open(sys.argv[1], encoding='utf-8').read())
blocking = 0
for m in matches:
    rule_id = str(getattr(getattr(m, 'rule', None), 'id', '') or 'E')
    severity = rule_id[0].upper()
    if severity != 'I':
        blocking += 1
    print(severity, str(m).replace('\\n', ' '))
print('FINDINGS', len(matches), blocking)
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
  const counts = /^FINDINGS (\d+) (\d+)$/.exec(countLine.trim())

  if (!counts) {
    console.error('cfn-lint produced unparseable output:')
    console.error(output)
    process.exit(1)
  }

  const findings = Number(counts[1])
  const blocking = Number(counts[2])

  for (const line of lines) {
    const severity = line.charAt(0)
    const text = line.slice(2)
    if (severity === 'I') console.log(`note: ${text}`)
    else console.error(text)
  }

  if (blocking === 0) {
    console.log(
      findings === 0
        ? '0 findings.'
        : `0 blocking findings (${findings} informational, reported above and not failing the check).`
    )
    process.exit(0)
  }

  console.error(`${blocking} blocking finding(s), ${findings - blocking} informational.`)
  process.exit(1)
}

console.error('UNAVAILABLE: no Python interpreter with cfn-lint was found. This is not a pass.')
console.error('Install it with:  pip install cfn-lint')
console.error('Or point at the right interpreter:  CFN_LINT_PYTHON=/path/to/python npm run lint:iac')
console.error('Tried:')
for (const line of tried) console.error(`  ${line}`)
process.exit(1)
