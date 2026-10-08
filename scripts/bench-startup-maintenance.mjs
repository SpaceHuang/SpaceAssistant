#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createTempDatabase } from '../electron/database/testHelpers.ts'
import { getDbConnection } from '../electron/database/sqliteStore.ts'
import { runSessionEventRetentionMaintenance } from '../electron/storage/sessionEventRetention.ts'
import { runSpillRetentionMaintenance } from '../electron/storage/spillStore.ts'
import { pruneAgentLogs } from '../electron/storage/agentLogRetention.ts'
import { cleanupMcpArtifacts } from '../electron/mcp/mcpArtifactCleanup.ts'
import { cleanupUsageFactsByRetention } from '../electron/usageStats/usageStatsMaintenance.ts'
import { readFileSync } from 'node:fs'

const args = new Map(process.argv.slice(2).map((value, index, list) => value.startsWith('--') ? [value.slice(2), list[index + 1]] : null).filter(Boolean))
const runs = Number(args.get('runs') ?? 5)
const seed = Number(args.get('seed') ?? 20261008)
const day = 24 * 60 * 60 * 1000
const results = []
const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
const deferredUntilWindowReady = /ready-to-show[\s\S]{0,700}startWindowReadyMaintenance\?\.\(\)/.test(mainSource) &&
  !/app\.whenReady\(\)[\s\S]{0,1000}cleanupMcpArtifactsOnStartup\(/.test(mainSource)

for (let run = 0; run < runs; run += 1) {
  const temp = createTempDatabase(`startup-maintenance-${seed}-${run}-`)
  const conn = getDbConnection(temp.db)
  const userData = path.join(path.dirname(temp.dbPath), 'user-data')
  const spillRoot = path.join(userData, 'spill')
  const mcpRoot = path.join(userData, 'shell-output', 'mcp')
  const logRoot = path.join(userData, 'logs')
  const workRoot = path.join(userData, 'workspace')
  await Promise.all([spillRoot, mcpRoot, logRoot, path.join(workRoot, 'sessions')].map((dir) => fs.mkdir(dir, { recursive: true })))

  const eventRoot = path.join(workRoot, 'sessions')
  const sessionCount = 150
  for (let index = 0; index < sessionCount; index += 1) {
    const name = `bench-${String(index).padStart(4, '0')}-20261008`
    const dir = path.join(eventRoot, name)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: seed + index }))
  }

  const artifactCount = 260
  for (let index = 0; index < artifactCount; index += 1) {
    const file = path.join(mcpRoot, `artifact-mcp-${String(index).padStart(4, '0')}.log`)
    const handle = await fs.open(file, 'w')
    try { await handle.truncate(1024 * 1024) } finally { await handle.close() }
    const old = new Date(Date.now() - (index + 1) * 60_000)
    await fs.utimes(file, old, old)
  }

  for (let index = 0; index < 40; index += 1) {
    const date = new Date(Date.now() - (40 - index) * day).toISOString().slice(0, 10).replaceAll('-', '')
    await fs.writeFile(path.join(logRoot, `Agent-${date}.log`), 'fixture')
  }
  conn.prepare(`INSERT INTO usage_step_facts(session_id,turn_id,step_id,created_at,day,source)
    VALUES('bench-session','bench-turn','bench-step',1,'2024-01-01','api')`).run()

  const descriptor = { version: 1, kind: 'degradable', locator: 'deadbeef-0000-4000-8000-000000000001.spill', byteLength: 1, sha256: 'a'.repeat(64), createdAt: Date.now() - 100 * day, head: '', tail: '' }
  await fs.writeFile(path.join(spillRoot, descriptor.locator), 'x')
  conn.prepare(`INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at)
    VALUES('bench-spill-session','bench-turn',0,1,'completed',?,1)`).run(JSON.stringify({ nested: { __spaceassistant_spill_v1: descriptor } }))

  const jobs = []
  const timed = async (name, work, summarize) => {
    const started = performance.now()
    const value = await work()
    jobs.push({ job: name, elapsedMs: performance.now() - started, ...summarize(value) })
  }
  try {
    await timed('mcp-artifact-cleanup', () => cleanupMcpArtifacts(mcpRoot), (value) => ({ scannedCount: value.scanned, deletedCount: value.ttlRemoved + value.quotaRemoved }))
    await timed('agent-log-retention', () => pruneAgentLogs({ logDir: logRoot, retentionDays: 30 }), (value) => ({ scannedCount: 40, deletedCount: value.removed }))
    await timed('session-event-retention', () => runSessionEventRetentionMaintenance(temp.db, workRoot), (value) => ({ scannedCount: sessionCount, deletedCount: value.summary.removed }))
    let spillFenceMs = 0
    let spillScannedCount = 0
    await timed('spill-degradable-retention', async () => {
      const started = performance.now()
      const value = await runSpillRetentionMaintenance(temp.db, spillRoot, Date.now() + 100 * day, { onReferenceScan: (stats) => { spillScannedCount = stats.descriptorCount } })
      spillFenceMs = performance.now() - started
      return value
    }, (value) => ({ scannedCount: spillScannedCount, deletedCount: value.length }))
    await timed('usage-facts-retention', () => cleanupUsageFactsByRetention(temp.db, Date.now() + 800 * day), (value) => ({ scannedCount: 1, deletedCount: value?.deletedStepRows ?? 0 }))
    results.push({ run, jobs, spillRootFenceMs: spillFenceMs, rssBytes: process.memoryUsage().rss })
  } finally {
    conn.close()
    temp.cleanup()
  }
}
console.log(JSON.stringify({ scenario: 'startup-maintenance-synthetic', seed, runs, deferredUntilWindowReady, results,
  note: 'This synthetic report times maintenance job owners directly; ready-to-show remains outside all job awaits.' }, null, 2))
if (!deferredUntilWindowReady) process.exitCode = 1
