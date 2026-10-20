import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import {
  bootstrapEmptySessionEventLedger,
  establishExistingSessionEventLedgerBaseline,
  getSessionEventSink,
  resolveSessionEventPaths
} from '../sessionEvents'
import { runInTransaction } from '../database/transaction'
import { buildCanonicalToolResultProjectionTargets, enqueueCanonicalLedgerProjectionTargetInTransaction } from '../sessionLedgerOutbox'
import type { SessionLedgerLifecycleDependencies } from '../sessionLedgerLifecycle'
import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from '../sessionLedgerIdentity'
import { readSessionLedgerReadiness, type SessionLedgerReadyProof } from '../sessionLedgerReadiness'
import { drainCanonicalLedgerProjectionOutbox } from '../sessionLedgerOutbox'
import { projectCanonicalSessionLedgerTarget } from './sessionLedgerOutboxProjector'

function canonicalWatermark(conn: DatabaseSync, location: SessionLedgerLocationInput): string {
  const row = conn.prepare(`SELECT events.event_id,events.session_seq FROM agent_history_events events
    WHERE events.session_id=? AND json_valid(events.payload_json)
      AND json_extract(events.payload_json,'$.sessionLedger.location.workDir')=?
      AND json_extract(events.payload_json,'$.sessionLedger.location.sessionId')=?
      AND json_extract(events.payload_json,'$.sessionLedger.location.createdAt')=?
    ORDER BY events.session_seq DESC LIMIT 1`)
    .get(location.sessionId, location.workDir, location.sessionId, location.createdAt) as { event_id: string; session_seq: number } | undefined
  return row ? `${row.session_seq}:${row.event_id}` : 'session:-1'
}

export async function readSessionLedgerReadyProof(conn: DatabaseSync, location: SessionLedgerLocationInput): Promise<SessionLedgerReadyProof | undefined> {
  const identity = sessionLedgerLocationIdentity(location)
  const readiness = readSessionLedgerReadiness(conn, identity.key)
  if (!readiness) return undefined
  const paths = resolveSessionEventPaths(location.workDir, location.sessionId, location.createdAt)
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>
  let directoryStat: Awaited<ReturnType<typeof fs.lstat>>
  let fileStat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    rootStat = await fs.lstat(paths.sessionsRoot)
    directoryStat = await fs.lstat(paths.directory)
    fileStat = await fs.lstat(paths.eventsPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
    fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('SESSION_LEDGER_PATH_NOT_REGULAR')
  const realRoot = await fs.realpath(paths.sessionsRoot)
  const realDirectory = await fs.realpath(paths.directory)
  const realEvents = await fs.realpath(paths.eventsPath)
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }
  if (!inside(realRoot, realDirectory) || !inside(realDirectory, realEvents)) throw new Error('SESSION_LEDGER_PATH_OUTSIDE_ROOT')
  const indexStat = await fs.lstat(paths.indexPath)
  if (indexStat.isSymbolicLink() || !indexStat.isFile()) throw new Error('SESSION_LEDGER_INDEX_NOT_REGULAR')
  const rawIndex = await fs.readFile(paths.indexPath, 'utf8')
  const index = JSON.parse(rawIndex) as { formatVersion?: number; seq?: number; eventCount?: number; bytes?: number; lastAt?: number }
  if (index.formatVersion !== 2 || !Number.isSafeInteger(index.seq) || !Number.isSafeInteger(index.eventCount) ||
    !Number.isSafeInteger(index.bytes) || !Number.isFinite(index.lastAt) || index.bytes !== fileStat.size) {
    throw new Error('SESSION_LEDGER_INDEX_PROOF_INVALID')
  }
  const handle = await fs.open(paths.eventsPath, 'r')
  const hash = createHash('sha256')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    while (offset < fileStat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, fileStat.size - offset), offset)
      if (!bytesRead) throw new Error('SESSION_LEDGER_PROOF_FILE_CHANGED')
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } finally { await handle.close() }
  return {
    canonicalWatermark: canonicalWatermark(conn, location),
    ledgerGeneration: readiness.ledgerGeneration,
    fileIdentity: `${fileStat.dev}:${fileStat.ino}:${fileStat.mtimeMs}`,
    fileBytes: fileStat.size,
    // The version tag distinguishes complete prefix digests from legacy tail hashes.
    tailFrame: `full:${hash.digest('hex')}`,
    indexSeq: index.seq!, indexEventCount: index.eventCount!, indexBytes: index.bytes!, indexLastAt: index.lastAt!
  }
}

async function legacyTailDigest(eventsPath: string, fileBytes: number): Promise<string> {
  const length = Math.min(fileBytes, 4096)
  const handle = await fs.open(eventsPath, 'r')
  const tail = Buffer.alloc(length)
  try {
    if (length) {
      const { bytesRead } = await handle.read(tail, 0, length, fileBytes - length)
      if (bytesRead !== length) throw new Error('SESSION_LEDGER_PROOF_FILE_CHANGED')
    }
  } finally { await handle.close() }
  return createHash('sha256').update(tail).digest('hex')
}

function readCanonicalSessionHistory(conn: DatabaseSync, sessionId: string): HistoryEvent[] {
  return conn.prepare(`SELECT events.invocation_id,events.sequence,events.event_id,events.idempotency_key,events.turn_id,
      events.schema_version,events.kind,events.payload_json
    FROM agent_history_events events JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
    WHERE streams.session_id=? ORDER BY events.session_seq,events.commit_order`).all(sessionId).map((raw) => {
      const row = raw as { invocation_id: string; sequence: number; event_id: string; idempotency_key: string; turn_id: string;
        schema_version: number; kind: HistoryEvent['kind']; payload_json: string }
      return { invocationId: row.invocation_id, sequence: row.sequence, eventId: row.event_id, idempotencyKey: row.idempotency_key,
        turnId: row.turn_id, schemaVersion: row.schema_version, kind: row.kind, payload: JSON.parse(row.payload_json) }
    })
}

export function createProductionSessionLedgerLifecycleDependencies(conn: DatabaseSync): SessionLedgerLifecycleDependencies {
  const proof = (location: SessionLedgerLocationInput) => readSessionLedgerReadyProof(conn, location)
  const verifyPhysicalContinuity: NonNullable<SessionLedgerLifecycleDependencies['verifyPhysicalContinuity']> = async (location, readiness) => {
    if (!readiness.proofFileIdentity || readiness.proofFileBytes === null || !readiness.proofTailFrame) return false
    const paths = resolveSessionEventPaths(location.workDir, location.sessionId, location.createdAt)
    const stat = await fs.lstat(paths.eventsPath)
    const identity = `${stat.dev}:${stat.ino}`
    if (stat.isSymbolicLink() || !stat.isFile() || identity !== readiness.proofFileIdentity.split(':').slice(0, 2).join(':') ||
      stat.size < readiness.proofFileBytes) return false
    const legacyProof = !readiness.proofTailFrame.startsWith('full:')
    const handle = await fs.open(paths.eventsPath, 'r')
    const hash = createHash('sha256')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      if (legacyProof) {
        const length = Math.min(readiness.proofFileBytes, 4096)
        const { bytesRead } = await handle.read(buffer, 0, length, readiness.proofFileBytes - length)
        if (bytesRead !== length) return false
        hash.update(buffer.subarray(0, bytesRead))
      } else {
        let offset = 0
        while (offset < readiness.proofFileBytes) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, readiness.proofFileBytes - offset), offset)
          if (!bytesRead) return false
          hash.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
      }
    } finally { await handle.close() }
    return (legacyProof ? hash.digest('hex') : `full:${hash.digest('hex')}`) === readiness.proofTailFrame
  }
  const migrateLegacyReadyProof: NonNullable<SessionLedgerLifecycleDependencies['migrateLegacyReadyProof']> = async (location, readiness) => {
    if (!readiness.proofTailFrame || readiness.proofTailFrame.startsWith('full:')) return undefined
    const upgraded = await proof(location)
    if (!upgraded) return undefined
    const oldStyleProof = { ...upgraded, tailFrame: await legacyTailDigest(
      resolveSessionEventPaths(location.workDir, location.sessionId, location.createdAt).eventsPath, upgraded.fileBytes) }
    const matches = readiness.canonicalWatermark === oldStyleProof.canonicalWatermark &&
      readiness.ledgerGeneration === oldStyleProof.ledgerGeneration && readiness.proofFileIdentity === oldStyleProof.fileIdentity &&
      readiness.proofFileBytes === oldStyleProof.fileBytes && readiness.proofTailFrame === oldStyleProof.tailFrame &&
      readiness.proofIndexSeq === oldStyleProof.indexSeq && readiness.proofIndexEventCount === oldStyleProof.indexEventCount &&
      readiness.proofIndexBytes === oldStyleProof.indexBytes && readiness.proofIndexLastAt === oldStyleProof.indexLastAt
    return matches ? upgraded : undefined
  }
  const project = async (location: SessionLedgerLocationInput, target: Parameters<typeof projectCanonicalSessionLedgerTarget>[1]) => {
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    return projectCanonicalSessionLedgerTarget(sink, target)
  }
  const dependencies: SessionLedgerLifecycleDependencies = {
    fileExists: async (location) => {
      const eventPath = resolveSessionEventPaths(location.workDir, location.sessionId, location.createdAt).eventsPath
      try {
        const stat = await fs.lstat(eventPath)
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('SESSION_LEDGER_PATH_NOT_REGULAR')
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    readProof: proof,
    verifyPhysicalContinuity,
    migrateLegacyReadyProof,
    bootstrap: async (location, bootstrapId) => {
      await bootstrapEmptySessionEventLedger(location.workDir, location.sessionId, location.createdAt, bootstrapId)
      const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
      await sink.flush()
      return await proof(location) ?? Promise.reject(new Error('SESSION_LEDGER_BOOTSTRAP_PROOF_MISSING'))
    },
    baseline: async (location) => {
      await establishExistingSessionEventLedgerBaseline(location.workDir, location.sessionId, location.createdAt)
      const identity = sessionLedgerLocationIdentity(location)
      const events = readCanonicalSessionHistory(conn, location.sessionId).filter((event) => {
        const ledgerLocation = (event.payload as { sessionLedger?: { location?: unknown } }).sessionLedger?.location as
          Partial<SessionLedgerLocationInput> | undefined
        return ledgerLocation?.workDir === location.workDir && ledgerLocation.sessionId === location.sessionId && ledgerLocation.createdAt === location.createdAt
      })
      const generation = (conn.prepare('SELECT generation FROM sessions WHERE id=?').get(location.sessionId) as { generation: string } | undefined)?.generation
      if (!generation) throw new Error('SESSION_LEDGER_SESSION_MISSING')
      const targets = buildCanonicalToolResultProjectionTargets(conn, events, location.sessionId, generation)
      runInTransaction(conn, () => {
        for (const target of targets) if (target.ledgerLocationKey === identity.key) enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target)
      })
      const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE ledger_location_key=?')
        .get(identity.key) as { ledger_location_key: string } | undefined
      if (!readiness) throw new Error('SESSION_LEDGER_READINESS_ROW_MISSING')
      const drained = await drainCanonicalLedgerProjectionOutbox(conn, identity.key, (target) => project(location, target))
      if (drained.failedTargetId) throw new Error('SESSION_LEDGER_BASELINE_PROJECTION_FAILED')
      return await proof(location) ?? Promise.reject(new Error('SESSION_LEDGER_BASELINE_PROOF_MISSING'))
    },
    applyTarget: project,
    reconcilePreviousOwner: async (location) => {
      const exists = await dependencies.fileExists(location)
      if (!exists) throw new Error('SESSION_LEDGER_BASELINE_FILE_MISSING')
      // Process-generation changes only fence the prior owner. Proof validation, targeted drain or a single baseline scan follows in the gate.
    }
  }
  return dependencies
}
