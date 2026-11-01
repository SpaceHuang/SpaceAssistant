#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const mode = args.includes('--mode=baseline') ? 'baseline' : args.includes('--mode=candidate') ? 'candidate' : undefined
const outputIndex = args.indexOf('--output')
const outputEquals = args.find((arg) => arg.startsWith('--output='))
const output = outputEquals ? outputEquals.slice('--output='.length) : outputIndex >= 0 ? args[outputIndex + 1] : undefined
const quick = args.includes('--quick')
if (!mode && !quick) throw new Error('usage: node scripts/session-storage-full-chain-bench.mjs --mode=baseline|candidate --output=<file> [--quick]')
const forwarded = args.filter((arg) => arg !== '--mode=baseline' && arg !== '--mode=candidate' && arg !== '--quick' && arg !== '--output' && arg !== output && !arg.startsWith('--output='))
const run = spawnSync(process.execPath, ['scripts/session-storage-full-chain-fixture.mjs', ...forwarded, ...(quick ? ['--quick'] : [])], {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
})
if (run.status !== 0) throw new Error(run.stderr || run.stdout || `fixture failed with ${run.status}`)
const record = JSON.parse(run.stdout)
record.mode = mode ?? 'quick-diagnostic'
record.build = { electron: fs.existsSync(path.join(root, 'dist-electron/electron/main.js')) ? 'present' : 'missing', renderer: fs.existsSync(path.join(root, 'dist/renderer/index.html')) ? 'present' : 'missing' }
if (output) { fs.mkdirSync(path.dirname(path.resolve(root, output)), { recursive: true }); fs.writeFileSync(path.resolve(root, output), `${JSON.stringify(record, null, 2)}\n`) }
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
