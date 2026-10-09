import { createHash } from 'node:crypto'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'

export const DEFERRED_ENVELOPE_SCHEMA_VERSION = 2
export const DEFERRED_ENVELOPE_CANONICALIZATION_VERSION = 'canonical-json-v1'

export type DeferredCallEnvelope = {
  invocationId: string
  requestId: string
  turnId: string
  toolCallId: string
  schemaVersion: number
  canonicalizationVersion: string
  toolName: string
  canonicalArgs: Record<string, unknown>
  canonicalArgsHash: string
  contentVersions: Record<string, number>
  contentVersionsHash: string
  executionContext: Record<string, unknown>
  executionContextHash: string
  integrityHash: string
  createdAt: number
}

export type DeferredCallEnvelopeInput = {
  invocationId: string
  requestId?: string
  turnId?: string
  toolCallId?: string
  toolName: string
  canonicalArgs: Record<string, unknown>
  contentVersions: Record<string, number>
  executionContext: Record<string, unknown>
  now?: number
}

function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const normalize = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number' && Number.isFinite(current)) return current
    if (typeof current !== 'object') throw new TypeError('INVALID_DEFERRED_ENVELOPE_VALUE')
    if (seen.has(current)) throw new TypeError('INVALID_DEFERRED_ENVELOPE_VALUE')
    seen.add(current)
    if (Array.isArray(current)) return current.map(normalize)
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('INVALID_DEFERRED_ENVELOPE_VALUE')
    return Object.fromEntries(Object.keys(current as object).sort().map((key) => [key, normalize((current as Record<string, unknown>)[key])]))
  }
  return JSON.stringify(normalize(value))
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function unsignedEnvelope(envelope: DeferredCallEnvelope): Omit<DeferredCallEnvelope, 'integrityHash'> {
  const { integrityHash: _integrityHash, ...unsigned } = envelope
  return unsigned
}

function validateVersion(envelope: Pick<DeferredCallEnvelope, 'schemaVersion' | 'canonicalizationVersion'>): void {
  if (envelope.schemaVersion !== DEFERRED_ENVELOPE_SCHEMA_VERSION) throw new Error('UNSUPPORTED_ENVELOPE_SCHEMA')
  if (envelope.canonicalizationVersion !== DEFERRED_ENVELOPE_CANONICALIZATION_VERSION) {
    throw new Error('UNSUPPORTED_ENVELOPE_CANONICALIZATION')
  }
}

function isIntact(envelope: DeferredCallEnvelope): boolean {
  try {
    validateVersion(envelope)
    return [envelope.invocationId, envelope.requestId, envelope.turnId, envelope.toolCallId, envelope.toolName].every((value) => value.trim().length > 0)
      && envelope.canonicalArgsHash === hash(envelope.canonicalArgs)
      && envelope.contentVersionsHash === hash(envelope.contentVersions)
      && envelope.executionContextHash === hash(envelope.executionContext)
      && envelope.integrityHash === hash(unsignedEnvelope(envelope))
  } catch {
    return false
  }
}

export function createDeferredEnvelopeStore(db: AppDatabase) {
  const conn = getDbConnection(db)
  return {
    put(input: DeferredCallEnvelopeInput): DeferredCallEnvelope {
      if (!input.invocationId.trim() || !input.toolName.trim()) throw new TypeError('DEFERRED_ENVELOPE_IDENTITY_REQUIRED')
      const snapshot = structuredClone(input)
      const unsigned: Omit<DeferredCallEnvelope, 'integrityHash'> = {
        invocationId: snapshot.invocationId,
        requestId: snapshot.requestId ?? snapshot.invocationId,
        turnId: snapshot.turnId ?? snapshot.invocationId,
        toolCallId: snapshot.toolCallId ?? snapshot.invocationId,
        schemaVersion: DEFERRED_ENVELOPE_SCHEMA_VERSION,
        canonicalizationVersion: DEFERRED_ENVELOPE_CANONICALIZATION_VERSION,
        toolName: snapshot.toolName,
        canonicalArgs: snapshot.canonicalArgs,
        canonicalArgsHash: hash(snapshot.canonicalArgs),
        contentVersions: snapshot.contentVersions,
        contentVersionsHash: hash(snapshot.contentVersions),
        executionContext: snapshot.executionContext,
        executionContextHash: hash(snapshot.executionContext),
        createdAt: snapshot.now ?? Date.now()
      }
      const envelope: DeferredCallEnvelope = { ...unsigned, integrityHash: hash(unsigned) }
      const prior = conn.prepare('SELECT integrity_hash FROM deferred_call_envelopes WHERE invocation_id=?')
        .get(envelope.invocationId) as { integrity_hash: string } | undefined
      if (prior) {
        const existing = this.get(envelope.invocationId)
        if (!existing || existing.integrityHash !== envelope.integrityHash) throw new Error('INVOCATION_ENVELOPE_CONFLICT')
        return existing
      }
      conn.prepare(`INSERT INTO deferred_call_envelopes(invocation_id,schema_version,canonicalization_version,envelope_json,integrity_hash,created_at)
        VALUES(?,?,?,?,?,?)`).run(
        envelope.invocationId, envelope.schemaVersion, envelope.canonicalizationVersion,
        JSON.stringify(envelope), envelope.integrityHash, envelope.createdAt
      )
      db.save()
      return envelope
    },

    get(invocationId: string): DeferredCallEnvelope | null {
      const row = conn.prepare('SELECT envelope_json FROM deferred_call_envelopes WHERE invocation_id=?')
        .get(invocationId) as { envelope_json: string } | undefined
      if (!row) return null
      try {
        const envelope = JSON.parse(row.envelope_json) as DeferredCallEnvelope
        if (envelope.invocationId !== invocationId || !isIntact(envelope)) return null
        return structuredClone(envelope)
      } catch {
        return null
      }
    },

    verify(envelope: DeferredCallEnvelope, current: {
      requestId?: string
      turnId?: string
      toolCallId?: string
      toolName: string
      canonicalArgs: Record<string, unknown>
      contentVersions: Record<string, number>
      executionContext: Record<string, unknown>
    }): { ok: true } | { ok: false; reason: 'integrity_mismatch' | 'call_changed' | 'tool_changed' | 'content_changed' | 'args_changed' | 'context_changed' } {
      validateVersion(envelope)
      if (!isIntact(envelope)) return { ok: false, reason: 'integrity_mismatch' }
      if ((current.requestId !== undefined && current.requestId !== envelope.requestId) ||
        (current.turnId !== undefined && current.turnId !== envelope.turnId) ||
        (current.toolCallId !== undefined && current.toolCallId !== envelope.toolCallId)) return { ok: false, reason: 'call_changed' }
      if (current.toolName !== envelope.toolName) return { ok: false, reason: 'tool_changed' }
      if (hash(current.canonicalArgs) !== envelope.canonicalArgsHash) return { ok: false, reason: 'args_changed' }
      if (hash(current.contentVersions) !== envelope.contentVersionsHash) return { ok: false, reason: 'content_changed' }
      if (hash(current.executionContext) !== envelope.executionContextHash) return { ok: false, reason: 'context_changed' }
      return { ok: true }
    }
  }
}
