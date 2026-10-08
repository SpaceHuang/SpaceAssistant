import type { DatabaseSync } from 'node:sqlite'
import { iterateSpillDescriptorReferencesStrict, type SpillDescriptor } from './spillProtocol'

/** SQLite-private owner kinds. This module is not exported through session-storage contracts. */
export type SpillReferenceOwnerTable = 'agent_history_events' | 'session_transcript_entries'
export type SpillReferenceIndexRow = Readonly<{
  owner_table: SpillReferenceOwnerTable
  owner_key: string
  descriptor_path: string
  owner_revision: string
  locator: string
  kind: SpillDescriptor['kind']
  descriptor_json: string
  updated_at: number
}>

export function spillTranscriptOwnerKey(sessionId: string, version: number): string {
  return JSON.stringify([sessionId, version])
}

export function spillHistoryOwnerKey(invocationId: string, eventId: string): string {
  return JSON.stringify([invocationId, eventId])
}

export function parseSpillHistoryOwnerKey(ownerKey: string): [string, string] {
  const value: unknown = JSON.parse(ownerKey)
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
    throw new Error('spill-reference-history-owner-key-malformed')
  }
  return [value[0], value[1]]
}

export function assertSpillReferencePayloadStrict(payloadJson: string): void {
  for (const _reference of iterateSpillDescriptorReferencesStrict(JSON.parse(payloadJson) as unknown)) { /* validate all nested marker paths */ }
}

/** Replace one owner's derived rows. Caller must include this operation in its canonical SQLite transaction. */
export function replaceSpillReferenceOwnerInTransaction(
  conn: DatabaseSync,
  ownerTable: SpillReferenceOwnerTable,
  ownerKey: string,
  payloadJson: string,
  now = Date.now()
): void {
  const payload = JSON.parse(payloadJson) as unknown
  const revisionRow = ownerTable === 'agent_history_events'
    ? conn.prepare('SELECT spill_reference_revision AS revision FROM agent_history_events WHERE invocation_id=? AND event_id=?').get(...parseSpillHistoryOwnerKey(ownerKey)) as { revision: number } | undefined
    : (() => {
        const [sessionId, version] = JSON.parse(ownerKey) as [string, number]
        return conn.prepare('SELECT spill_reference_revision AS revision FROM session_transcript_entries WHERE session_id=? AND version=?').get(sessionId, version) as { revision: number } | undefined
      })()
  if (!revisionRow) throw new Error('canonical spill reference owner is unavailable')
  const revision = String(revisionRow.revision)
  const rows = [...iterateSpillDescriptorReferencesStrict(payload)].map(({ path: descriptorPath, descriptor }) => ({
    descriptorPath,
    descriptorJson: JSON.stringify(descriptor),
    locator: descriptor.locator,
    kind: descriptor.kind
  }))
  conn.prepare('DELETE FROM spill_reference_index WHERE owner_table=? AND owner_key=?').run(ownerTable, ownerKey)
  const insert = conn.prepare(`INSERT INTO spill_reference_index(
    owner_table,owner_key,descriptor_path,owner_revision,locator,kind,descriptor_json,updated_at
  ) VALUES(?,?,?,?,?,?,?,?)`)
  for (const row of rows) insert.run(ownerTable, ownerKey, row.descriptorPath, revision, row.locator, row.kind, row.descriptorJson, now)
}

export function deleteSpillReferenceOwnerInTransaction(conn: DatabaseSync, ownerTable: SpillReferenceOwnerTable, ownerKey: string): void {
  conn.prepare('DELETE FROM spill_reference_index WHERE owner_table=? AND owner_key=?').run(ownerTable, ownerKey)
}

export function getCanonicalSpillChangeGeneration(conn: DatabaseSync): number {
  const row = conn.prepare("SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation'").get() as { meta_value: number } | undefined
  if (!row || !Number.isSafeInteger(row.meta_value) || row.meta_value < 0) throw new Error('canonical spill reference generation is unavailable')
  return row.meta_value
}

export function readSpillReferenceIndexRows(conn: DatabaseSync): SpillReferenceIndexRow[] {
  return conn.prepare(`SELECT owner_table,owner_key,descriptor_path,owner_revision,locator,kind,descriptor_json,updated_at
    FROM spill_reference_index ORDER BY owner_table,owner_key,descriptor_path`).all() as SpillReferenceIndexRow[]
}
