#!/usr/bin/env node
/**
 * Audits every independent dependency tree.
 *
 * A root-only `npm audit` sees the workspaces and nothing else. The Lambda and
 * the dataset scripts each carry their own lockfile, so a vulnerability in
 * either is invisible from the repository root — which is exactly how one goes
 * unnoticed. The policy this enforces is documented in docs/DEPENDENCIES.md.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TREES = [
  {
    name: 'workspaces (production dependencies)',
    cwd: root,
    args: ['audit', '--json', '--omit=dev', '--audit-level=low'],
    blocking: true,
  },
  {
    name: 'workspaces (development dependencies)',
    cwd: root,
    args: ['audit', '--json', '--audit-level=high'],
    blocking: false,
  },
  {
    name: 'lambda timeline handler',
    cwd: resolve(root, 'backend/lambda/timelineHandler'),
    args: ['audit', '--json', '--audit-level=high'],
    blocking: true,
  },
  {
    name: 'dataset scripts',
    cwd: resolve(root, 'scripts'),
    args: ['audit', '--json', '--audit-level=high'],
    blocking: true,
  },
]

let failed = false

for (const tree of TREES) {
  console.log(`\n=== ${tree.name} ===`)
  const result = spawnSync('npm', tree.args, {
    cwd: tree.cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    // npm writes a non-JSON error response when the registry is unavailable,
    // when its cache is inaccessible, or when the executable cannot run. That
    // is not evidence of an advisory and must not be reported as one.
    const detail = [stderr.trim(), stdout.trim(), result.error?.message].filter(Boolean).join('\n')
    console.error(`UNVERIFIABLE: npm audit could not produce a report for ${tree.name}.`)
    if (detail) console.error(detail)
    failed = true
    continue
  }

  if (report.error || !report.metadata?.vulnerabilities) {
    const detail = report.error?.summary ?? report.error?.message ?? stderr.trim()
    console.error(`UNVERIFIABLE: npm audit could not complete for ${tree.name}.`)
    if (detail) console.error(detail)
    failed = true
    continue
  }

  const counts = report.metadata.vulnerabilities
  const summary = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${severity}=${count}`)
    .join(', ')
  console.log(summary ? `Reported vulnerabilities: ${summary}` : 'No vulnerabilities reported.')

  if (result.status !== 0) {
    if (tree.blocking) {
      console.error(`BLOCKING: advisories found in ${tree.name}`)
      failed = true
    } else {
      console.warn(
        `reported (non-blocking): advisories in ${tree.name}. ` +
          'Each must be fixed or listed in docs/DEPENDENCIES.md with a reachability assessment.'
      )
    }
  }
}

if (failed) {
  console.error('\nDependency audit failed. See docs/DEPENDENCIES.md for the policy.')
  process.exit(1)
}

console.log('\nAll blocking dependency trees are clean.')
