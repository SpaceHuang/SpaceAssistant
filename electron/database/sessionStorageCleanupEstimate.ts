import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { collectSessionStorageProfile } from './sessionStorageProfile'
import { getSessionLedgerRecoveryRoots } from '../runtime/sessionLedgerRecovery'
import { RETENTION_POLICY_CONFIG_KEYS, resolveRetentionPolicy } from '../storage/retentionPolicy'
import { readCanonicalSpillReferences } from '../storage/spillStore'
import type { SpillDescriptor } from '../storage/spillProtocol'

type ProfileTable = { rows: number; textBytes: number } | null
type ProfileObject = { name: string; pages: number; bytes: number }

type RetentionDirectoryInventory = {
  roots: number
  indexedDirectories: number
  retainedByCount: number
  retainedByCountBytes: number
  beyondCountCandidateDirectories: number
  beyondCountCandidateBytes: number
  unindexedDirectories: number
  unindexedDirectoryBytes: number
  countBoundaryTie: boolean
  sizingIncomplete: boolean
}

function directoryBytes(root: string): { bytes: number; complete: boolean } {
  let bytes = 0
  let complete = true
  const visit = (current: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) }
    catch { complete = false; return }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name)
      try {
        const stat = fs.lstatSync(filePath)
        if (stat.isSymbolicLink()) { complete = false; continue }
        if (stat.isDirectory()) visit(filePath)
        else if (stat.isFile()) bytes += stat.size
        else complete = false
      } catch { complete = false }
    }
  }
  visit(root)
  return { bytes, complete }
}

function inventorySessionEventDirectories(roots: readonly string[], maxSessions: number): RetentionDirectoryInventory {
  let indexedDirectories = 0
  let retainedByCount = 0
  let retainedByCountBytes = 0
  let beyondCountCandidateDirectories = 0
  let beyondCountCandidateBytes = 0
  let unindexedDirectories = 0
  let unindexedDirectoryBytes = 0
  let countBoundaryTie = false
  let sizingIncomplete = false
  for (const workDir of roots) {
    const sessionsRoot = path.join(workDir, 'sessions')
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(sessionsRoot, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      sizingIncomplete = true
      continue
    }
    const indexed: Array<{ directory: string; lastAt: number }> = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = path.join(sessionsRoot, entry.name)
      try {
        const index = JSON.parse(fs.readFileSync(path.join(directory, 'events.index.json'), 'utf8')) as { lastAt?: unknown } | null
        if (index && typeof index === 'object') indexed.push({ directory,
          lastAt: typeof index.lastAt === 'number' && Number.isFinite(index.lastAt) ? index.lastAt : 0 })
        else {
          unindexedDirectories += 1
          const measured = directoryBytes(directory)
          unindexedDirectoryBytes += measured.bytes
          sizingIncomplete ||= !measured.complete
        }
      } catch {
        unindexedDirectories += 1
        const measured = directoryBytes(directory)
        unindexedDirectoryBytes += measured.bytes
        sizingIncomplete ||= !measured.complete
      }
    }
    indexedDirectories += indexed.length
    indexed.sort((left, right) => right.lastAt - left.lastAt || left.directory.localeCompare(right.directory))
    if (indexed.length > maxSessions && indexed[maxSessions - 1]?.lastAt === indexed[maxSessions]?.lastAt) countBoundaryTie = true
    for (const [index, entry] of indexed.entries()) {
      const measured = directoryBytes(entry.directory)
      sizingIncomplete ||= !measured.complete
      if (index < maxSessions) {
        retainedByCount += 1
        retainedByCountBytes += measured.bytes
      } else {
        beyondCountCandidateDirectories += 1
        beyondCountCandidateBytes += measured.bytes
      }
    }
  }
  return { roots: roots.length, indexedDirectories, retainedByCount, retainedByCountBytes,
    beyondCountCandidateDirectories, beyondCountCandidateBytes, unindexedDirectories, unindexedDirectoryBytes, countBoundaryTie, sizingIncomplete }
}

/** Read-only M4-5 estimate. Candidates are never treated as deletion authorization. */
export function collectSessionStorageCleanupEstimate(dbPath: string, now = Date.now()): Record<string, unknown> {
  const profile = collectSessionStorageProfile(dbPath) as {
    collectedAt: string; schemaVersion: number | null; dbBytes: number; databaseFiles: { totalBytes: number }
    pageSize: { page_size: number }; pageCount: { page_count: number }; freelistCount: { freelist_count: number }
    dbstat: ProfileObject[] | null; tables: { messages: ProfileTable; canonicalHistory: ProfileTable; transcriptSnapshots: ProfileTable }
    canonicalRequiredData: { eventRows: number; eventPayloadBytes: number; streamRows: number; streamTableBytes: number | null }
    spillFiles: { totalBytes: number | null; sourceOfTruthBytes: number | null; degradableBytes: number | null; orphanBytes: number | null; complete: boolean; errorCodes: string[] }
    spillDegraded: { files: number; totalBytes: number | null; complete: boolean; errorCodes: string[] }
    sourceTruthGc: { pendingFiles: number; pendingBytes: number; orphanBytes: number; scanStatus: string }
    messageBodyCoverage: { identityBodyCandidateCount: number; identityBodyCandidateBytes?: number }
  }
  const conn = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name))
    const getConfig = (key: string): string | undefined => tables.has('configs')
      ? (conn.prepare('SELECT value FROM configs WHERE key=?').get(key) as { value: string } | undefined)?.value
      : undefined
    const retention = resolveRetentionPolicy({ getConfigValue: getConfig })
    const roots = getSessionLedgerRecoveryRoots(getConfig('config.workDir'), getConfig('config.workDirProfiles'))
    const sessionEventDirectories = inventorySessionEventDirectories(roots, retention.sessionEventMaxSessions)
    const spillReferenceByLocator = new Map<string, SpillDescriptor>()
    let estimateReferenceScanComplete = true
    try {
      for (const descriptor of readCanonicalSpillReferences(conn, { allowMissingTables: true }).descriptors) {
        const previous = spillReferenceByLocator.get(descriptor.locator)
        if (previous && (previous.kind !== descriptor.kind || previous.sha256 !== descriptor.sha256 || previous.byteLength !== descriptor.byteLength)) {
          estimateReferenceScanComplete = false
          continue
        }
        spillReferenceByLocator.set(descriptor.locator, descriptor)
      }
    } catch { estimateReferenceScanComplete = false }
    const spillRoot = path.join(path.dirname(dbPath), 'spill')
    const expiredDegradableSpill = new Set<string>()
    const degradableCutoff = now - retention.degradableSpillRetentionDays * 24 * 60 * 60 * 1000
    let expiredDegradableSpillBytesObserved = 0
    let missingReferencedSpillFiles = 0
    for (const descriptor of spillReferenceByLocator.values()) {
      const filePath = path.join(spillRoot, descriptor.locator)
      try {
        const stat = fs.lstatSync(filePath)
        if (stat.isSymbolicLink() || !stat.isFile()) { missingReferencedSpillFiles += 1; estimateReferenceScanComplete = false; continue }
        if (descriptor.kind === 'degradable' && descriptor.createdAt < degradableCutoff) {
          expiredDegradableSpill.add(descriptor.locator)
          expiredDegradableSpillBytesObserved += stat.size
        }
      } catch (error) {
        missingReferencedSpillFiles += 1
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code !== 'ENOENT') estimateReferenceScanComplete = false
      }
    }
    const spillInventoryComplete = profile.spillFiles.complete && profile.spillDegraded.complete && estimateReferenceScanComplete && missingReferencedSpillFiles === 0
    const expiredDegradableSpillBytes = spillInventoryComplete ? expiredDegradableSpillBytesObserved : null

    const dbstat = profile.dbstat ?? []
    const objectBytes = new Map(dbstat.map(({ name, bytes }) => [name, bytes]))
    const indexes = dbstat.filter(({ name }) => name.startsWith('idx_') || name.startsWith('sqlite_autoindex_'))
    const retainedCoreTables = [
      'agent_history_events', 'agent_history_streams', 'agent_history_commit_cursor', 'agent_history_pending_commit_cursor',
      'session_event_cursor', 'sessions', 'turns', 'session_execution_claims', 'session_execution_queue',
      'session_turn_commit_receipts', 'session_transcript_checkpoints', 'session_message_content_cutover',
      'session_message_content_cleanup_progress', 'session_transcript_entries'
    ]
    const canonicalAndFlowObjectFloorBytes = retainedCoreTables.reduce((sum, name) => sum + (objectBytes.get(name) ?? 0), 0) +
      indexes.reduce((sum, item) => sum + item.bytes, 0) + (objectBytes.get('sqlite_schema') ?? 0)
    const transcriptRows = profile.tables.transcriptSnapshots?.rows ?? 0
    const transcriptBytes = profile.tables.transcriptSnapshots?.textBytes ?? 0
    const exactBodyCandidateBytes = profile.messageBodyCoverage.identityBodyCandidateBytes ?? 0
    const messagesTableBytes = objectBytes.get('messages') ?? 0
    const nonMessageObjectBytes = dbstat.filter(({ name }) => name !== 'messages').reduce((sum, item) => sum + item.bytes, 0)
    const maximumPossibleMessageTableReclaim = Math.min(messagesTableBytes, Math.max(0, profile.dbBytes - nonMessageObjectBytes))
    return {
      collectedAt: new Date(now).toISOString(), schemaVersion: profile.schemaVersion,
      database: { dbBytes: profile.dbBytes, databaseFilesBytes: profile.databaseFiles.totalBytes,
        pageSize: profile.pageSize.page_size, pageCount: profile.pageCount.page_count, freelistCount: profile.freelistCount.freelist_count },
      candidates: {
        sessionEventDirectories: { ...sessionEventDirectories, maxSessions: retention.sessionEventMaxSessions,
          byteMetric: 'sum of regular-file stat.size; excludes directory metadata, allocation blocks and symlink targets',
          deletionAuthorized: false, requiresProjectionDependencyCheck: true },
        duplicateMessageBodies: { exactIdentityRows: profile.messageBodyCoverage.identityBodyCandidateCount,
          rawContentBytes: exactBodyCandidateBytes, deletionAuthorized: false,
          gate: 'requires per-session canonical identity and cleanup certification; legacy-required rows are excluded; production cleanup also requires the rollback-floor release audit' },
        transcriptSnapshots: { rows: transcriptRows, rawJsonBytes: transcriptBytes, deletionAuthorized: false,
          gate: 'retained by the current turn transcript/recovery contract; separate owner review required' },
        degradableSpill: { referencedBytes: profile.spillFiles.degradableBytes,
          expiredByConfiguredPolicyBytes: expiredDegradableSpillBytes, retentionDays: retention.degradableSpillRetentionDays,
          deletionAuthorized: false, note: 'existing spill retention verifies canonical reconstruction before deletion' },
        degradableSpillCopies: { files: profile.spillDegraded.complete ? profile.spillDegraded.files : null, bytes: profile.spillDegraded.totalBytes,
          deletionAuthorized: false, gate: 'copy retention and canonical equivalence are not inferred by this estimate' },
        unreferencedSpill: { bytes: profile.spillFiles.orphanBytes, deletionAuthorized: false,
          gate: 'full canonical reference scan and durable GC protocol' },
        sourceTruthSpillGc: { ...profile.sourceTruthGc, deletionAuthorized: false,
          gate: 'durable queue and complete reference scan must authorize source-of-truth unlink' }
      },
      mustRetain: {
        canonicalHistoryTableBytes: objectBytes.get('agent_history_events') ?? null,
        canonicalStreamTableBytes: profile.canonicalRequiredData.streamTableBytes,
        canonicalEventPayloadBytes: profile.canonicalRequiredData.eventPayloadBytes,
        sourceOfTruthSpillBytes: profile.spillFiles.sourceOfTruthBytes,
        messageSkeletonRows: profile.tables.messages?.rows ?? null,
        transcriptSnapshotBytesPendingOwnerReview: transcriptBytes,
        indexedObjectsBytes: indexes.reduce((sum, item) => sum + item.bytes, 0),
        indexedObjects: indexes.map(({ name, pages, bytes }) => ({ name, pages, bytes }))
      },
      physicalSpaceEstimate: {
        knownRequiredCoreObjectsBytes: canonicalAndFlowObjectFloorBytes,
        dbFileBytesAfterHypotheticalMessageCleanup: { lowerBoundBytes: Math.max(0, profile.dbBytes - maximumPossibleMessageTableReclaim), upperBoundBytes: profile.dbBytes },
        maximumPotentialLogicalPayloadBytes: exactBodyCandidateBytes,
        maximumPotentialSpillBytesOutsideDatabase: expiredDegradableSpillBytes,
        estimatedDatabaseShrinkBytes: { lowerBound: 0,
          upperBound: maximumPossibleMessageTableReclaim },
        note: 'Upper bound conservatively assumes every page in the messages table could be reclaimed while all other database objects remain. Logical body bytes do not establish physical savings; only a later vacuum measurement can establish DB file shrink.'
      },
      measured: { currentMessagesTableBytes: objectBytes.get('messages') ?? null,
        currentTranscriptSnapshotTableBytes: objectBytes.get('session_transcript_entries') ?? null,
        currentDatabaseObjects: dbstat.map(({ name, pages, bytes }) => ({ name, pages, bytes })) },
      completeness: { dbstatAvailable: profile.dbstat !== null, sessionDirectoryRootsAvailable: roots.length > 0,
        sessionDirectorySizingComplete: roots.length > 0 && !sessionEventDirectories.sizingIncomplete,
        spillInventoryComplete, spillReferenceScanComplete: estimateReferenceScanComplete,
        spillScanErrorCodes: [...new Set([...profile.spillFiles.errorCodes, ...profile.spillDegraded.errorCodes,
          ...(!estimateReferenceScanComplete ? ['ESTIMATE_SPILL_REFERENCE_SCAN_FAILED'] : [])])],
        missingReferencedSpillFiles, expiredDegradableSpillLocators: expiredDegradableSpillBytes === null ? null : expiredDegradableSpill.size }
    }
  } finally { conn.close() }
}
