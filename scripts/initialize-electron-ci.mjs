import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const binaryPath = require('electron')

if (!existsSync(binaryPath)) {
  throw new Error(`Electron binary does not exist at ${binaryPath}`)
}

const result = spawnSync(binaryPath, ['--version'], { stdio: 'inherit' })
if (result.error) throw new Error(`Could not start Electron at ${binaryPath}: ${result.error.message}`)
if (result.status !== 0) throw new Error(`Electron --version exited with status ${result.status ?? 'unknown'}`)
