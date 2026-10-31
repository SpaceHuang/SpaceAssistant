#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createFixtureDefinition } from './session-storage-full-chain-options.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const { fixture, runnerTimeoutMs } = createFixtureDefinition(args)
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-session-storage-bench-'))
const fixturePath = path.join(tempDir, 'fixture.json')
const resultPath = path.join(tempDir, 'result.json')
fs.writeFileSync(fixturePath, JSON.stringify(fixture))
try {
  const run = spawnSync(require('electron'), ['scripts/fixtures/session-storage-full-chain-electron-runner.cjs', fixturePath, resultPath], {
    cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: runnerTimeoutMs
  })
  if (run.status !== 0) throw new Error(`Electron runner failed (${run.status ?? run.error?.code ?? 'unknown'}):\n${run.stderr}\n${run.stdout}`)
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  process.stdout.write(`${JSON.stringify({ fixture, result }, null, 2)}\n`)
} finally { fs.rmSync(tempDir, { recursive: true, force: true }) }
