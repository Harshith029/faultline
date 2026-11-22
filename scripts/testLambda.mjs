#!/usr/bin/env node
/**
 * Runs the Lambda's unit tests as part of the root `npm test`.
 *
 * The Lambda is not a root workspace. It keeps its own lockfile so that its
 * deployment artifact holds exactly the dependencies it declares, which means
 * the root install never installs the AWS SDK that handler.js imports. In a
 * fresh clone the suite could not even load. The first run installs those
 * dependencies from the Lambda's own lockfile; later runs reuse them.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const lambdaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../backend/lambda/timelineHandler')

const npm = (args) => {
  const { status, error } = spawnSync('npm', args, {
    cwd: lambdaDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (error) throw error
  if (status !== 0) process.exit(status ?? 1)
}

// npm writes this file only when an install completes, so an interrupted
// install is retried instead of leaving the suite with half a dependency tree.
if (!existsSync(join(lambdaDir, 'node_modules', '.package-lock.json'))) {
  console.log('Installing the Lambda dependencies from its own lockfile (first run only)')
  npm(['ci', '--no-audit', '--no-fund'])
}

npm(['test'])
