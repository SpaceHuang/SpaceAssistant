import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './index'
import { createSession } from './operations'
import { getDbConnection } from './sqliteStore'
import { ensureLegacyLedgerReadiness } from '../sessionLedgerReadiness'

const retiredProofColumns = [
  'proof_file_identity', 'proof_file_bytes', 'proof_tail_frame', 'proof_index_seq',
  'proof_index_event_count', 'proof_index_bytes', 'proof_index_last_at'
]
const retiredPayloadColumns = ['expected_events_json', 'expected_event_ids_json', 'payload_sha256']

function tableColumns(conn: ReturnType<typeof getDbConnection>, table: string): string[] {
  return (conn.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(({ name }) => name)
}

describe('session ledger retired-column migration variants', () => {
  it('runs the rehearsal against disposable copies and reports the frozen DROP list', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-migration-cli-'))
    const dbPath = path.join(root, 'closed-isolated.db')
    const db = openDatabase(dbPath)
    try {
      const conn = getDbConnection(db)
      const session = createSession(db, { name: 'migration-cli' })
      const readiness = ensureLegacyLedgerReadiness(conn, { workDir: root, sessionId: session.id, createdAt: session.createdAt }, session.generation)
      conn.prepare(`INSERT INTO session_ledger_projection_outbox(target_id,ledger_location_key,session_id,session_generation,
        canonical_event_id,canonical_sequence,projection_order,projection_kind,expected_events_json,expected_event_ids_json,
        payload_sha256,status,created_at) VALUES('cli-target',?,?,?,'cli-event',1,0,'tool-result','[]','[]',?,'pending',1)`)
        .run(readiness.ledgerLocationKey, session.id, session.generation, 'b'.repeat(64))
    } finally { db.close() }

    try {
      const output = execFileSync(process.execPath, ['--import', 'tsx', path.resolve(process.cwd(), 'scripts/rehearse-session-ledger-column-migrations.ts'), dbPath],
        { cwd: process.cwd(), encoding: 'utf8' })
      const result = JSON.parse(output.trim()) as { sourceUnchanged: boolean; variants: Array<{ variant: string; dropped: string[]; rollbackVerified: boolean }> }
      expect(result.sourceUnchanged).toBe(true)
      expect(result.variants).toEqual([
        { variant: 'proof-only', dropped: retiredProofColumns, rollbackVerified: true },
        { variant: 'proof-and-outbox-payload', dropped: [...retiredProofColumns, ...retiredPayloadColumns], rollbackVerified: true }
      ])
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it.each([
    { file: 'session-ledger-proof-only.sql', keepPayload: true },
    { file: 'session-ledger-proof-and-outbox-payload.sql', keepPayload: false }
  ])('applies $file to an isolated DB and restores the closed snapshot', async ({ file, keepPayload }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-retired-columns-'))
    const dbPath = path.join(root, 'isolated.db')
    const backupPath = `${dbPath}.before-migration`
    let db = openDatabase(dbPath)
    try {
      const conn = getDbConnection(db)
      const session = createSession(db, { name: `migration-${file}` })
      const readiness = ensureLegacyLedgerReadiness(conn, { workDir: root, sessionId: session.id, createdAt: session.createdAt }, session.generation)
      const proof = ['old-id', 12, 'old-tail', 3, 4, 12, 99] as const
      conn.prepare(`UPDATE session_ledger_projection_state SET ${retiredProofColumns.map((column) => `${column}=?`).join(',')}
        WHERE ledger_location_key=?`).run(...proof, readiness.ledgerLocationKey)
      conn.prepare(`INSERT INTO session_ledger_projection_outbox(target_id,ledger_location_key,session_id,session_generation,
        canonical_event_id,canonical_sequence,projection_order,projection_kind,expected_events_json,expected_event_ids_json,
        payload_sha256,status,created_at) VALUES('migration-target',?,?,?,'migration-event',1,0,'tool-result','[]','[]',?,'pending',1)`)
        .run(readiness.ledgerLocationKey, session.id, session.generation, 'a'.repeat(64))
      db.close()
      await fs.copyFile(dbPath, backupPath)
      db = openDatabase(dbPath)
      const stateColumnsBefore = tableColumns(getDbConnection(db), 'session_ledger_projection_state')
      const outboxColumnsBefore = tableColumns(getDbConnection(db), 'session_ledger_projection_outbox')
      const migration = await fs.readFile(path.resolve(process.cwd(), 'scripts/migrations', file), 'utf8')
      getDbConnection(db).exec(migration)

      const migrated = getDbConnection(db)
      expect(tableColumns(migrated, 'session_ledger_projection_state').filter((name) => retiredProofColumns.includes(name))).toEqual([])
      const outboxColumns = tableColumns(migrated, 'session_ledger_projection_outbox')
      expect(outboxColumns.filter((name) => retiredPayloadColumns.includes(name))).toEqual(keepPayload ? retiredPayloadColumns : [])
      expect(tableColumns(migrated, 'session_ledger_projection_state'))
        .toEqual(stateColumnsBefore.filter((name) => !retiredProofColumns.includes(name)))
      expect(outboxColumns).toEqual(outboxColumnsBefore.filter((name) => keepPayload || !retiredPayloadColumns.includes(name)))
      if (keepPayload) expect(migrated.prepare("SELECT expected_events_json,expected_event_ids_json,payload_sha256 FROM session_ledger_projection_outbox WHERE target_id='migration-target'")
        .get()).toEqual({ expected_events_json: '[]', expected_event_ids_json: '[]', payload_sha256: 'a'.repeat(64) })

      db.close()
      await fs.copyFile(backupPath, dbPath)
      db = openDatabase(dbPath)
      const rolledBack = getDbConnection(db)
      expect(tableColumns(rolledBack, 'session_ledger_projection_state').filter((name) => retiredProofColumns.includes(name)))
        .toEqual(retiredProofColumns)
      expect(rolledBack.prepare(`SELECT ${retiredProofColumns.join(',')} FROM session_ledger_projection_state WHERE ledger_location_key=?`)
        .get(readiness.ledgerLocationKey)).toEqual(Object.fromEntries(retiredProofColumns.map((column, index) => [column, proof[index]])))
      expect(rolledBack.prepare("SELECT expected_events_json,expected_event_ids_json,payload_sha256 FROM session_ledger_projection_outbox WHERE target_id='migration-target'")
        .get()).toEqual({ expected_events_json: '[]', expected_event_ids_json: '[]', payload_sha256: 'a'.repeat(64) })
    } finally {
      db.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
