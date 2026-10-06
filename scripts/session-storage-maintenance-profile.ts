import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../electron/database'
import { getDbConnection } from '../electron/database/sqliteStore'
import { collectSessionStorageProfile } from '../electron/database/sessionStorageProfile'
import { certifyCanonicalSessionApiRead, beginSessionMessageContentCleanup, clearNextSessionMessageContentBatch,
  markSessionMessageContentWriteStopped, setCanonicalApiReadFeatureEnabled, verifyAndCompleteSessionMessageContentCleanup } from '../electron/runtime/sessionStorageCutover'
import { enableCanonicalSessionWriteAuthority } from '../electron/runtime/sessionContentWriteAuthority'
import { compactSessionDatabase } from '../electron/storage/sessionStorageMaintenance'

const sourcePath = process.argv[2]
const reportPathArg = process.argv[3]
const sampleCount = Number(process.argv[4] ?? 3)
if (!sourcePath || !reportPathArg || !Number.isSafeInteger(sampleCount) || sampleCount < 2 || sampleCount > 10) {
  throw new Error('Usage: node --import tsx scripts/session-storage-maintenance-profile.ts <synthetic-cleanup-db> <report-json-path> [paired-sample-count:2..10]')
}

function percentile(values: number[], p: number): number {
  const ordered = [...values].sort((a, b) => a - b)
  const rank = (ordered.length - 1) * p
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return ordered[lower]!
  const fraction = rank - lower
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * fraction
}

function startupSample(dbPath: string): Record<string, unknown> {
  const script = path.join(process.cwd(), 'scripts/session-storage-cold-start-profile.ts')
  const child = spawnSync(process.execPath, ['--import', 'tsx', script, dbPath, '--include-synthetic-sidecars'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024
  })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`cold-start profile failed (${child.status}): ${child.stderr.slice(-8_000)}`)
  try { return JSON.parse(child.stdout) as Record<string, unknown> }
  catch { throw new Error(`cold-start profile returned invalid JSON: ${child.stdout.slice(-2_000)}\n${child.stderr.slice(-2_000)}`) }
}

function profileSummary(dbPath: string): Record<string, unknown> {
  const profile = collectSessionStorageProfile(dbPath) as any
  return {
    schemaVersion: profile.schemaVersion,
    dbBytes: profile.dbBytes,
    databaseFiles: profile.databaseFiles,
    pageSize: profile.pageSize.page_size,
    pageCount: profile.pageCount.page_count,
    freelistCount: profile.freelistCount.freelist_count,
    autoVacuum: profile.autoVacuum.auto_vacuum,
    dbstatObjects: profile.dbstat,
    messages: profile.tables.messages,
    canonicalHistory: profile.tables.canonicalHistory,
    transcriptSnapshots: profile.tables.transcriptSnapshots,
    canonicalRequiredData: profile.canonicalRequiredData,
    spillBytes: { total: profile.spillFiles.totalBytes, sourceOfTruth: profile.spillFiles.sourceOfTruthBytes,
      degradable: profile.spillFiles.degradableBytes, orphan: profile.spillFiles.orphanBytes },
    messageBodyCoverage: { messages: profile.messageBodyCoverage.messages,
      exactIdentityCandidates: profile.messageBodyCoverage.identityBodyCandidateCount,
      exactIdentityCandidateBytes: profile.messageBodyCoverage.identityBodyCandidateBytes }
  }
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = fs.createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

async function main(): Promise<void> {
const sourceDb = path.resolve(sourcePath)
const reportPath = path.resolve(reportPathArg)
const inputDbSha256Before = await sha256File(sourceDb)
const sourceConn = new DatabaseSync(sourceDb, { readOnly: true })
let candidateSessionId: string
try {
  const marker = sourceConn.prepare("SELECT value FROM configs WHERE key='sessionStorage.syntheticProfileFixture'").get() as { value: string } | undefined
  if (marker?.value !== 'synthetic-session-storage-cleanup-v1') {
    throw new Error('maintenance profile accepts only synthetic-session-storage-cleanup-v1 databases')
  }
  candidateSessionId = (sourceConn.prepare('SELECT session_id FROM messages WHERE id=?').get('synthetic-cleanup-identity-message') as
    { session_id: string } | undefined)?.session_id ?? ''
  if (!candidateSessionId) throw new Error('synthetic exact-identity cleanup candidate is missing')
} finally { sourceConn.close() }

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-storage-maintenance-profile-'))
const beforeDbPath = path.join(temporaryRoot, 'before', 'spaceassistant-data.db')
const afterDbPath = path.join(temporaryRoot, 'after', 'spaceassistant-data.db')
fs.mkdirSync(path.dirname(beforeDbPath), { recursive: true })
fs.mkdirSync(path.dirname(afterDbPath), { recursive: true })
fs.copyFileSync(sourceDb, beforeDbPath)
fs.copyFileSync(sourceDb, afterDbPath)
for (const samplePath of [beforeDbPath, afterDbPath]) {
  for (const spillName of ['spill', 'spill-degraded']) {
    const sourceSpill = path.join(path.dirname(sourceDb), spillName)
    if (!fs.existsSync(sourceSpill)) continue
    fs.cpSync(sourceSpill, path.join(path.dirname(samplePath), spillName), { recursive: true, errorOnExist: true })
  }
}

let cleanupEvidence: Record<string, unknown>
let compactionEvidence: Record<string, unknown>
try {
  const initialProfile = profileSummary(sourceDb)
  const prepareCandidate = (db: ReturnType<typeof openDatabase>) => {
    setCanonicalApiReadFeatureEnabled(db, true)
    const certification = certifyCanonicalSessionApiRead(db, candidateSessionId)
    if (certification.status !== 'eligible') throw new Error(`synthetic cleanup candidate is not eligible: ${certification.reason ?? 'unknown'}`)
    const writeAuthority = enableCanonicalSessionWriteAuthority(db, candidateSessionId)
    if (writeAuthority.status !== 'enabled') throw new Error(`synthetic cleanup write authority was not enabled: ${writeAuthority.reason ?? 'unknown'}`)
    if (!markSessionMessageContentWriteStopped(db, candidateSessionId) || !beginSessionMessageContentCleanup(db, candidateSessionId)) {
      throw new Error('synthetic cleanup candidate did not enter pending cleanup')
    }
    return { certified: true, writeAuthorityEnabled: true }
  }
  const beforeDb = openDatabase(beforeDbPath)
  const candidatePreparation = prepareCandidate(beforeDb)
  beforeDb.flushSave()
  beforeDb.close()
  const beforeProfile = profileSummary(beforeDbPath)
  let db = openDatabase(afterDbPath)
  prepareCandidate(db)
  const batches: Array<{ status: string; cleanedMessageCount: number }> = []
  for (let batch = 0; batch < 10; batch += 1) {
    const result = clearNextSessionMessageContentBatch(db, candidateSessionId, 100)
    batches.push({ status: result.status, cleanedMessageCount: result.cleanedMessageCount })
    if (result.status === 'complete') break
    if (result.status !== 'advanced') throw new Error(`synthetic cleanup batch failed: ${result.reason ?? 'unknown'}`)
  }
  db.close()
  db = openDatabase(afterDbPath)
  const cleanupVerified = verifyAndCompleteSessionMessageContentCleanup(db, candidateSessionId)
  if (!cleanupVerified) throw new Error('synthetic cleanup verification failed after database reopen')
  cleanupEvidence = { ...candidatePreparation, batches, reopenedVerification: cleanupVerified }

  const compaction = await compactSessionDatabase(db, path.dirname(afterDbPath))
  compactionEvidence = {
    dbBytesBefore: compaction.bytesBefore, dbBytesAfter: compaction.bytesAfter,
    bytesReclaimed: Math.max(0, compaction.bytesBefore - compaction.bytesAfter),
    pageCountBefore: compaction.pageCountBefore, pageCountAfter: compaction.pageCountAfter,
    freelistCountBefore: compaction.freelistCountBefore, freelistCountAfter: compaction.freelistCountAfter,
    durationMs: compaction.durationMs, archiveBytes: compaction.archiveBytes,
    availableBytesBefore: compaction.availableBytesBefore, peakSpaceEstimateBytes: compaction.peakSpaceEstimateBytes,
    walBytesBefore: compaction.walBytesBefore, walBytesAfter: compaction.walBytesAfter,
    shmBytesBefore: compaction.shmBytesBefore, shmBytesAfter: compaction.shmBytesAfter,
    manifest: JSON.parse(fs.readFileSync(compaction.manifestPath, 'utf8'))
  }
  db.close()

  const afterProfile = profileSummary(afterDbPath)
  const pairedStarts = Array.from({ length: sampleCount }, (_, index) => {
    const order = index % 2 === 0 ? ['before', 'after'] as const : ['after', 'before'] as const
    const pair = {} as Record<'before' | 'after', Record<string, unknown>>
    for (const condition of order) pair[condition] = startupSample(condition === 'before' ? beforeDbPath : afterDbPath)
    return { order, before: pair.before, after: pair.after }
  })
  const beforeStarts = pairedStarts.map(({ before }) => before)
  const afterStarts = pairedStarts.map(({ after }) => after)
  const phases = (samples: Array<Record<string, unknown>>) => {
    const values = new Map<string, number[]>()
    for (const sample of samples) {
      for (const raw of sample.phases as string[]) {
        const start = raw.indexOf('{')
        if (start < 0) continue
        const phase = JSON.parse(raw.slice(start)) as { phase?: string; durationMs?: number }
        if (!phase.phase || typeof phase.durationMs !== 'number') continue
        const current = values.get(phase.phase) ?? []
        current.push(phase.durationMs)
        values.set(phase.phase, current)
      }
    }
    return Object.fromEntries([...values].map(([phase, durations]) => [phase, { samples: durations,
      p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) }]))
  }
  const wallTimes = (samples: Array<Record<string, unknown>>) => samples.map(({ coldStartWallMs }) => Number(coldStartWallMs))
  const report = {
    formatVersion: 1,
    observedAt: new Date().toISOString(),
    sample: { type: 'synthetic', marker: 'synthetic-session-storage-cleanup-v1', containsUserData: false,
      sqliteSchema: (profileSummary(sourceDb) as any).schemaVersion, osFilesystemCacheControlled: false,
      sampleCount, sampleDesign: 'paired-interleaved-alternating-order', pairOrder: pairedStarts.map(({ order }) => order),
      inputDbSha256Before, inputDbSha256After: await sha256File(sourceDb),
      directoriesAndSpillsClonedToEachIsolatedStartup: true },
    initial: { databaseProfile: initialProfile },
    cleanup: cleanupEvidence,
    compaction: compactionEvidence,
    before: { databaseProfile: beforeProfile,
      startup: { coldStartWallMs: { samples: wallTimes(beforeStarts), p50Ms: percentile(wallTimes(beforeStarts), 0.5), p95Ms: percentile(wallTimes(beforeStarts), 0.95) },
        phases: phases(beforeStarts) } },
    after: { databaseProfile: afterProfile,
      startup: { coldStartWallMs: { samples: wallTimes(afterStarts), p50Ms: percentile(wallTimes(afterStarts), 0.5), p95Ms: percentile(wallTimes(afterStarts), 0.95) },
        phases: phases(afterStarts) } },
    pairedStartup: pairedStarts.map(({ order, before, after }, index) => ({ pair: index + 1, order,
      beforeTotalMs: Number(before.coldStartWallMs), afterTotalMs: Number(after.coldStartWallMs),
      deltaAfterMinusBeforeMs: Number(after.coldStartWallMs) - Number(before.coldStartWallMs) })),
    attribution: {
      safetyPreparationDatabaseGrowthBytes: (beforeProfile as any).dbBytes - (initialProfile as any).dbBytes,
      logicalCleanupAndVacuumDatabaseShrinkBytes: (beforeProfile as any).dbBytes - (afterProfile as any).dbBytes,
      databaseBytesAtVacuumStart: (compactionEvidence as any).dbBytesBefore,
      databaseBytesAfterVacuum: (compactionEvidence as any).dbBytesAfter,
      messagesTableBytesBefore: (beforeProfile as any).dbstatObjects.find((item: any) => item.name === 'messages')?.bytes ?? null,
      messagesTableBytesAfter: (afterProfile as any).dbstatObjects.find((item: any) => item.name === 'messages')?.bytes ?? null,
      canonicalEventPayloadBytesBefore: (beforeProfile as any).canonicalRequiredData.eventPayloadBytes,
      canonicalEventPayloadBytesAfter: (afterProfile as any).canonicalRequiredData.eventPayloadBytes,
      transcriptSnapshotBytesBefore: (beforeProfile as any).transcriptSnapshots.textBytes,
      transcriptSnapshotBytesAfter: (afterProfile as any).transcriptSnapshots.textBytes,
      spillBytesBefore: (beforeProfile as any).spillBytes,
      spillBytesAfter: (afterProfile as any).spillBytes,
      note: 'The only intentional content change is the exact-identity eligible messages.content row. VACUUM accounts for physical file shrink. Startup phase deltas are single-machine synthetic observations with uncontrolled OS filesystem cache; they do not prove production p95 or cold-cache behavior.'
    }
  }
  if (report.sample.inputDbSha256Before !== report.sample.inputDbSha256After) throw new Error('synthetic input database changed during measurement')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ reportPath, cleanup: cleanupEvidence, compaction: compactionEvidence,
    initialDbBytes: (initialProfile as any).dbBytes, beforeCleanupDbBytes: (beforeProfile as any).dbBytes,
    afterCleanupDbBytes: (afterProfile as any).dbBytes,
    beforeStartup: (report.before as any).startup, afterStartup: (report.after as any).startup }, null, 2)}\n`)
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
