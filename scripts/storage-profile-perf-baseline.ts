import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { collectSessionStorageProfile } from '../electron/database/sessionStorageProfile'
import { runStorageProfileWorker } from '../electron/storageProfile/storageProfileWorkerClient'
import { createStorageProfileFixture, type StorageProfileFixtureSize } from './storage-profile-perf-baseline-fixture'

const WARMUP_RUNS = 2
const MEASURED_RUNS = 7
const SIZES: StorageProfileFixtureSize[] = ['small', 'medium', 'large']

async function main() {
  const mode = process.argv.includes('--mode=worker') ? 'worker' : 'sync'
  const results = []
  for (const size of SIZES) {
    const fixture = createStorageProfileFixture(size)
    try {
      for (let i = 0; i < WARMUP_RUNS; i += 1) {
        if (mode === 'worker') await runStorageProfileWorker({ type: 'audit', dbPath: fixture.dbPath })
        else collectSessionStorageProfile(fixture.dbPath)
      }
      const handlerMs: number[] = []
      const ipcProbeMs: number[] = []
      for (let i = 0; i < MEASURED_RUNS; i += 1) {
        const probeStart = performance.now()
        const probe = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - probeStart), 0))
        const start = performance.now()
        const profile = mode === 'worker'
          ? (await runStorageProfileWorker({ type: 'audit', dbPath: fixture.dbPath })).result
          : collectSessionStorageProfile(fixture.dbPath)
        handlerMs.push(performance.now() - start)
        ipcProbeMs.push(await probe)
        assertProfileRedacted(profile)
      }
      results.push({ fixture: fixture.spec, warmupRuns: WARMUP_RUNS, measuredRuns: MEASURED_RUNS,
        handlerMs: summarize(handlerMs), mainProcessResponsivenessProbeMs: summarize(ipcProbeMs) })
    } finally { fixture.cleanup() }
  }
  const command = mode === 'worker' ? 'node --import tsx scripts/storage-profile-perf-baseline.ts --mode=worker --output=docs/plan/evidence/storage-profile-after.json' : 'node --import tsx scripts/storage-profile-perf-baseline.ts'
  const evidence = { schemaVersion: 1, measurement: { mode, command, node: process.version,
    npm: process.env.npm_config_user_agent?.split(' ')[0] ?? execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch,
    statistic: 'median and nearest-rank p95', thresholds: { mainProcessResponsivenessProbeP95Ms: 50 },
    notes: mode === 'worker' ? 'The timer probe is queued immediately before the worker request. Handler duration includes worker startup, collection and exit; responsiveness measures main event-loop unavailability while collection runs in the worker.' : 'The timer probe is queued immediately before synchronous profile collection and measures event-loop unavailability. Handler duration and the queued probe are distinct recorded stages; exceeding the target is expected baseline evidence, not a script failure.' }, results }
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length)
    ?? 'docs/plan/evidence/storage-profile-before.json'
  fs.mkdirSync(new URL('.', `file://${process.cwd()}/${output}`).pathname, { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: round(sorted[Math.floor(sorted.length / 2)]), p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), unit: 'ms' }
}

function round(value: number) { return Number(value.toFixed(3)) }

function assertProfileRedacted(profile: Record<string, unknown>) {
  const serialized = JSON.stringify(profile)
  if (/fixture-0|m-0|private fixture body/.test(serialized)) throw new Error('Profile output appears to contain fixture content or identifiers')
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1 })
