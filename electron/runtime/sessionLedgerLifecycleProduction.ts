import fs from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import {
  bootstrapEmptySessionEventLedger,
  createSessionEventLedgerRebuildStage,
  discardSessionEventLedgerRebuildStage,
  establishExistingSessionEventLedgerBaseline,
  getSessionEventSink,
  publishSessionEventLedgerRebuildStage,
  quarantineDegradedSessionEventLedger,
  quarantineSessionEventLedgerForPhysicalMismatch,
  recoverInterruptedSessionEventLedgerQuarantine,
  resolveSessionEventPaths
} from '../sessionEvents'
import { runInTransaction } from '../database/transaction'
import { buildCanonicalToolResultProjectionTargets, canonicalLedgerProjectionTargetId, enqueueCanonicalLedgerProjectionTargetInTransaction } from '../sessionLedgerOutbox'
import type { SessionLedgerLifecycleDependencies } from '../sessionLedgerLifecycle'
import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from '../sessionLedgerIdentity'
import { readSessionLedgerReadiness, type SessionLedgerReadyProof } from '../sessionLedgerReadiness'
import { drainCanonicalLedgerProjectionOutbox } from '../sessionLedgerOutbox'
import { projectCanonicalSessionLedgerTarget, resolveCanonicalSessionLedgerProjectionTarget } from './sessionLedgerOutboxProjector'

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
  return { canonicalWatermark: canonicalWatermark(conn, location), ledgerGeneration: readiness.ledgerGeneration }
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
  const project = async (location: SessionLedgerLocationInput, target: Parameters<typeof projectCanonicalSessionLedgerTarget>[1]) => {
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    return projectCanonicalSessionLedgerTarget(sink, target)
  }
  const dependencies: SessionLedgerLifecycleDependencies = {
    fileExists: async (location) => {
      await recoverInterruptedSessionEventLedgerQuarantine(location)
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
      const drained = await drainCanonicalLedgerProjectionOutbox(conn, identity.key, (target) => project(location, target), Date.now(),
        (targetIdentity) => resolveCanonicalSessionLedgerProjectionTarget(conn, targetIdentity))
      if (drained.failedTargetId) throw new Error('SESSION_LEDGER_BASELINE_PROJECTION_FAILED')
      if (drained.sourceMissing?.length) throw new Error('SESSION_LEDGER_PROJECTION_SOURCE_MISSING')
      return await proof(location) ?? Promise.reject(new Error('SESSION_LEDGER_BASELINE_PROOF_MISSING'))
    },
    rebuildMissingLegacyLedger: async (location) => {
      // This recovery path is only authorized for an entirely absent ledger. A partial
      // directory or either surviving ledger artifact is evidence that must be reviewed.
      const events = readCanonicalSessionHistory(conn, location.sessionId).filter((event) => {
        const ledgerLocation = (event.payload as { sessionLedger?: { location?: unknown } }).sessionLedger?.location as
          Partial<SessionLedgerLocationInput> | undefined
        return ledgerLocation?.workDir === location.workDir && ledgerLocation.sessionId === location.sessionId && ledgerLocation.createdAt === location.createdAt
      })
      if (!events.length) throw new Error('SESSION_LEDGER_REBUILD_CANONICAL_HISTORY_MISSING')
      const identity = sessionLedgerLocationIdentity(location)
      const generation = (conn.prepare('SELECT generation FROM sessions WHERE id=?').get(location.sessionId) as { generation: string } | undefined)?.generation
      if (!generation) throw new Error('SESSION_LEDGER_SESSION_MISSING')
      const targets = buildCanonicalToolResultProjectionTargets(conn, events, location.sessionId, generation)
        .filter((target) => target.ledgerLocationKey === identity.key)
      // Reset acknowledgements before creating any replacement artifact. If the process stops at any later
      // boundary, the ordinary baseline retry still sees pending canonical obligations and completes replay.
      runInTransaction(conn, () => {
        for (const target of targets) enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target)
        // The previous ack proves projection into the old file. A newly created file has no such contents,
        // so every durable obligation must be replayed against this rebuild before a ready proof is minted.
        conn.prepare(`UPDATE session_ledger_projection_outbox SET status='pending',acked_at=NULL WHERE ledger_location_key=?`)
          .run(identity.key)
      })
      const stage = await createSessionEventLedgerRebuildStage(location)
      const sink = getSessionEventSink(stage.workDir, location.sessionId, location.createdAt)
      try {
        for (const target of targets) await projectCanonicalSessionLedgerTarget(sink, target)
        await sink.flush()
        await sink.close()
        await publishSessionEventLedgerRebuildStage(location, stage)
        const drained = await drainCanonicalLedgerProjectionOutbox(conn, identity.key, (target) => project(location, target), Date.now(),
          (targetIdentity) => resolveCanonicalSessionLedgerProjectionTarget(conn, targetIdentity))
        if (drained.failedTargetId) throw new Error('SESSION_LEDGER_REBUILD_PROJECTION_FAILED')
        if (drained.sourceMissing?.length) throw new Error('SESSION_LEDGER_PROJECTION_SOURCE_MISSING')
        const persistedTargets = conn.prepare(`SELECT target_id,status FROM session_ledger_projection_outbox WHERE ledger_location_key=?`)
          .all(identity.key) as Array<{ target_id: string; status: string }>
        const expectedTargetIds = new Set(targets.map(canonicalLedgerProjectionTargetId))
        if (persistedTargets.length !== expectedTargetIds.size || persistedTargets.some(({ target_id, status }) =>
          status !== 'acked' || !expectedTargetIds.has(target_id))) {
          throw new Error('SESSION_LEDGER_REBUILD_PROJECTION_SET_INCOMPLETE')
        }
      } catch (error) {
        await sink.close().catch(() => undefined)
        await discardSessionEventLedgerRebuildStage(location, stage).catch(() => undefined)
        throw error
      }
      return await proof(location) ?? Promise.reject(new Error('SESSION_LEDGER_REBUILD_PROOF_MISSING'))
    },
    quarantineDegradedLedger: async (location) => {
      await quarantineDegradedSessionEventLedger(location)
    },
    rebuildPhysicalMismatch: async (location) => {
      await quarantineSessionEventLedgerForPhysicalMismatch(location)
      if (!dependencies.rebuildMissingLegacyLedger) throw new Error('SESSION_LEDGER_PHYSICAL_MISMATCH_REBUILD_UNAVAILABLE')
      return dependencies.rebuildMissingLegacyLedger(location)
    },
    applyTarget: project,
    resolveCanonicalTarget: (identity) => resolveCanonicalSessionLedgerProjectionTarget(conn, identity),
    reconcilePreviousOwner: async (location) => {
      const exists = await dependencies.fileExists(location)
      if (!exists) throw new Error('SESSION_LEDGER_BASELINE_FILE_MISSING')
      // Process-generation changes only fence the prior owner. Proof validation, targeted drain or a single baseline scan follows in the gate.
    }
  }
  return dependencies
}
