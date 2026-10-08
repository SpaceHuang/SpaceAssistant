#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createTempDatabase } from '../electron/database/testHelpers.ts'
import { getDbConnection } from '../electron/database/sqliteStore.ts'
import { replaceSpillReferenceOwnerInTransaction, readSpillReferenceIndexRows } from '../electron/storage/spillReferenceIndex.ts'
import { readCanonicalSpillReferences } from '../electron/storage/spillStore.ts'
import { runSpillReferenceBackfillBatch } from '../electron/storage/spillReferenceBackfill.ts'
import { runSpillReferenceReconciliationBatch } from '../electron/storage/spillReferenceReconciliation.ts'

const args = new Map(process.argv.slice(2).map((value, index, list) => value.startsWith('--') ? [value.slice(2), list[index + 1]] : null).filter(Boolean))
const scenario = args.get('scenario')
const rows = Number(args.get('rows') ?? 20_000)
const transcriptRows = Number(args.get('transcript-rows') ?? 2_000)
const payloadBytes = Number(args.get('payload-bytes') ?? 4096)
const warmup = Number(args.get('warmup') ?? 1)
const runs = Number(args.get('runs') ?? 5)
const seed = Number(args.get('seed') ?? 20261008)

function percentile(values, point) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(point * sorted.length) - 1)]
}
function summary(values) { return { medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), runs: values } }
function locatorFor(id) { return `${id.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001.spill` }
function marker(locator, kind) {
  return { version: 1, kind, locator, byteLength: 64, sha256: 'f'.repeat(64), createdAt: 1700000000000, head: 'sample', tail: 'sample' }
}
function makePayload(index, targetBytes, locator, kind) {
  const base = { nested: [{ document: { __spaceassistant_spill_v1: marker(locator, kind) } }] }
  const initial = JSON.stringify(base)
  const paddingBytes = Math.max(0, targetBytes - Buffer.byteLength(initial) - 16)
  return JSON.stringify({ ...base, padding: 'x'.repeat(paddingBytes), fixtureSeed: seed + index })
}

async function ownerSizeScenario(reconcile = false) {
  const temp = createTempDatabase('spill-index-size-bench-')
  try {
    const conn = getDbConnection(temp.db)
    const sizes = [8 * 1024 * 1024 - 1024, 64 * 1024 * 1024 - 1024]
    conn.exec('BEGIN IMMEDIATE')
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,1,1,NULL)')
    const insertEvent = conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES(?,1,?,?,?,1,'invocation-context-committed',?,1)`)
    for (let index = 0; index < sizes.length; index += 1) {
      const id = `size-${index}`
      insertStream.run(id)
      insertEvent.run(id, `${id}-event`, `${id}-key`, 'turn', makePayload(index, sizes[index], locatorFor(index + 1), 'source-of-truth'))
    }
    const denseItems = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`d${index}`, { __spaceassistant_spill_v1: marker(locatorFor(50_000 + index), 'degradable') }]))
    insertStream.run('dense')
    insertEvent.run('dense', 'dense-event', 'dense-key', 'turn', JSON.stringify(denseItems))
    if (!reconcile) {
      insertStream.run('size-over-limit')
      insertEvent.run('size-over-limit', 'size-over-limit-event', 'size-over-limit-key', 'turn', `"${'x'.repeat(64 * 1024 * 1024)}"`)
    }
    conn.exec('COMMIT')
    const preflight = conn.prepare(`SELECT event_id,length(CAST(payload_json AS BLOB)) AS bytes FROM agent_history_events ORDER BY event_id`).all()
    const start = performance.now()
    const results = []
    if (reconcile) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const result = await runSpillReferenceBackfillBatch(conn)
        results.push(result)
        if (result.status === 'failed' || result.status === 'paused' || result.processedOwners === 0) break
      }
      const audits = []
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const result = await runSpillReferenceReconciliationBatch(conn)
        audits.push(result)
        if (result.status === 'complete' || result.status === 'failed' || result.status === 'paused' || result.status === 'idle') break
      }
      const elapsedMs = performance.now() - start
      return { scenario: 'reconciliation-owner-size-boundaries', seed, owners: preflight.map((item) => ({ eventId: item.event_id, bytes: item.bytes })),
        backfillActivations: results, reconciliationActivations: audits, batchElapsedMs: elapsedMs, rssBytes: process.memoryUsage().rss }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await runSpillReferenceBackfillBatch(conn)
      results.push(result)
      if (result.status === 'failed' || result.status === 'paused' || result.processedOwners === 0) break
    }
    const elapsedMs = performance.now() - start
    const result = results.at(-1)
    return { scenario: 'owner-size-boundaries', seed, owners: preflight.map((item) => ({ eventId: item.event_id, bytes: item.bytes,
      payloadReadByWorker: item.bytes <= 64 * 1024 * 1024 })), over64MiBRejectedBeforePayloadRead: result?.status === 'failed' && result.error?.includes('owner-payload-over-limit'),
      batchElapsedMs: elapsedMs, activations: results, rssBytes: process.memoryUsage().rss }
  } finally { temp.cleanup() }
}

async function main() {
  if (scenario === 'owner-size-boundaries') {
    const report = await ownerSizeScenario()
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (scenario === 'reconciliation-owner-size-boundaries') {
    const report = await ownerSizeScenario(true)
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const temp = createTempDatabase('spill-index-bench-')
  try {
    const conn = getDbConnection(temp.db)
    const spillDir = path.join(path.dirname(temp.dbPath), 'spill')
    fs.mkdirSync(spillDir, { recursive: true })
    const fixtureCount = rows + transcriptRows
    const uniqueGroups = Math.ceil(fixtureCount / 20)
    const kinds = new Map()
    for (let group = 0; group < uniqueGroups; group += 1) {
      const locator = locatorFor(seed + group)
      const kind = group % 2 === 0 ? 'source-of-truth' : 'degradable'
      kinds.set(locator, kind)
      fs.writeFileSync(path.join(spillDir, locator), Buffer.alloc(64, group % 251))
    }
    conn.exec('BEGIN IMMEDIATE')
    const stream = conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,1,1,NULL)')
    const event = conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES(?,1,?,?,?,1,'invocation-context-committed',?,1)`)
    const transcript = conn.prepare(`INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at)
      VALUES(?,?,0,1,'completed',?,1)`)
    let ordinal = 0
    for (let index = 0; index < rows; index += 1, ordinal += 1) {
      const group = Math.floor(ordinal / 20)
      const locator = locatorFor(seed + group)
      const kind = kinds.get(locator)
      const payload = makePayload(index, payloadBytes, locator, kind)
      stream.run(`bench-${index}`)
      event.run(`bench-${index}`, `bench-event-${index}`, `bench-key-${index}`, 'bench-turn', payload)
      replaceSpillReferenceOwnerInTransaction(conn, 'agent_history_events', `bench-event-${index}`, payload, 1)
    }
    for (let index = 0; index < transcriptRows; index += 1, ordinal += 1) {
      const group = Math.floor(ordinal / 20)
      const locator = locatorFor(seed + group)
      const kind = kinds.get(locator)
      const payload = makePayload(index + rows, payloadBytes, locator, kind)
      const sessionId = `bench-session-${index}`
      transcript.run(sessionId, 'bench-turn', payload)
      replaceSpillReferenceOwnerInTransaction(conn, 'session_transcript_entries', JSON.stringify([sessionId, 1]), payload, 1)
    }
    conn.exec('COMMIT')

    const strictRuns = []
    const indexRuns = []
    let strictStats
    let indexStats
    for (let iteration = 0; iteration < warmup + runs; iteration += 1) {
      let started = performance.now()
      const strict = readCanonicalSpillReferences(conn)
      const strictMs = performance.now() - started
      const files = new Map(strict.descriptors.map(({ locator, kind }) => [locator, kind]))
      const strictBytes = [...files].reduce((sum, [locator]) => sum + fs.statSync(path.join(spillDir, locator)).size, 0)
      strictStats = { descriptorCount: strict.descriptors.length, uniqueLocatorCount: strict.referencedLocators.size,
        sourceOfTruthFiles: [...files.values()].filter((kind) => kind === 'source-of-truth').length,
        degradableFiles: [...files.values()].filter((kind) => kind === 'degradable').length, bytes: strictBytes }
      started = performance.now()
      const indexedRows = readSpillReferenceIndexRows(conn)
      const indexMs = performance.now() - started
      const indexedFiles = new Map(indexedRows.map(({ locator, kind }) => [locator, kind]))
      const indexBytes = [...indexedFiles].reduce((sum, [locator]) => sum + fs.statSync(path.join(spillDir, locator)).size, 0)
      indexStats = { descriptorCount: indexedRows.length, uniqueLocatorCount: indexedFiles.size,
        sourceOfTruthFiles: [...indexedFiles.values()].filter((kind) => kind === 'source-of-truth').length,
        degradableFiles: [...indexedFiles.values()].filter((kind) => kind === 'degradable').length, bytes: indexBytes }
      if (iteration >= warmup) { strictRuns.push(strictMs); indexRuns.push(indexMs) }
    }
    const identical = JSON.stringify(strictStats) === JSON.stringify(indexStats)
    const strict = summary(strictRuns)
    const indexed = summary(indexRuns)
    const report = { scenario: 'canonical-reference-collection', seed, owners: { history: rows, transcript: transcriptRows }, payloadBytesPerOwner: payloadBytes,
      warmup, timedRuns: runs, strictStats, indexStats, identicalNonzeroStats: identical, strict, index: indexed,
      medianSpeedup: strict.medianMs / indexed.medianMs, meetsTwoXGate: identical && strict.medianMs / indexed.medianMs >= 2,
      rssBytes: process.memoryUsage().rss, note: 'Complete profile duration is intentionally not part of the 2x gate.' }
    console.log(JSON.stringify(report, null, 2))
    if (!identical || !report.meetsTwoXGate) process.exitCode = 1
  } finally { temp.cleanup() }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1 })
