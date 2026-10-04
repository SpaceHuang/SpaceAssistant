import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { collectSessionStorageProfile } from './sessionStorageProfile'

const tempPaths: string[] = []
afterEach(() => { for (const file of tempPaths.splice(0)) { try { fs.rmSync(file, { force: true, recursive: true }) } catch { /* best effort */ } } })

describe('collectSessionStorageProfile', () => {
  it('reports byte/count metadata without changing the database or exposing message text', () => {
    const dbPath = path.join(os.tmpdir(), `storage-profile-${process.pid}.db`)
    tempPaths.push(dbPath)
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id TEXT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, thinking TEXT, attachments TEXT, content_segments TEXT);
      INSERT INTO sessions VALUES('s'); INSERT INTO sessions VALUES('fingerprint-only'); INSERT INTO sessions VALUES('compacted');
      INSERT INTO messages VALUES('m','s','assistant','private body',NULL,NULL,NULL,NULL);
      INSERT INTO messages VALUES('same-body-other-id','s','assistant','private body',NULL,NULL,NULL,NULL);
      CREATE TABLE agent_history_streams(invocation_id TEXT, session_id TEXT); CREATE TABLE agent_history_events(invocation_id TEXT, kind TEXT, payload_json TEXT);
      INSERT INTO agent_history_streams VALUES('i','s'); INSERT INTO agent_history_streams VALUES('j','fingerprint-only'); INSERT INTO agent_history_streams VALUES('k','compacted');
      INSERT INTO agent_history_events VALUES('i','model-response-committed','{"message":{"id":"m","role":"assistant","content":"private body"}}');
      INSERT INTO agent_history_events VALUES('j','session-input-committed','{"sessionId":"fingerprint-only"}');
      INSERT INTO agent_history_events VALUES('k','transcript-compacted','{"messages":[]}');`)
    db.close()
    const profile = collectSessionStorageProfile(dbPath)
    expect(profile).toMatchObject({
      tables: { messages: { rows: 2 }, canonicalHistory: { rows: 3 } },
      canonicalCoverage: { streams: 3, withResponse: 1, fingerprintOnly: 1, compactedWithoutContext: 1 },
      canonicalSessionCoverage: { sessions: 3, sessionsWithResponse: 1, fingerprintOnlySessions: 1, compactedWithoutContextSessions: 1 },
      messageBodyCoverage: { messages: 2, bodyMatched: 2, byRole: { assistant: { messages: 2, bodyMatched: 2 } }, identityBodyCandidateCount: 1, identityBodyCandidatesByRole: { assistant: { messages: 2, candidateMatches: 1 } } }
    })
    expect(JSON.stringify(profile)).not.toContain('private body')
    const verify = new DatabaseSync(dbPath, { readOnly: true })
    expect(verify.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 })
    verify.close()
  })

  it('reports source-truth, degradable, and unreferenced spill bytes by class', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-profile-spill-'))
    tempPaths.push(root)
    const dbPath = path.join(root, 'spaceassistant.db')
    const spillRoot = path.join(root, 'spill')
    fs.mkdirSync(spillRoot)
    const descriptor = (locator: string, kind: string) => ({ version: 1, kind, locator, byteLength: 4, sha256: '0'.repeat(64), createdAt: 1, head: '', tail: '' })
    const sourceLocator = '00000000-0000-4000-8000-000000000011.spill'
    const degradableLocator = '00000000-0000-4000-8000-000000000012.spill'
    const orphanLocator = '00000000-0000-4000-8000-000000000013.spill'
    fs.writeFileSync(path.join(spillRoot, sourceLocator), '1234')
    fs.writeFileSync(path.join(spillRoot, degradableLocator), '12345')
    fs.writeFileSync(path.join(spillRoot, orphanLocator), '12')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE agent_history_events(payload_json TEXT NOT NULL);
      CREATE TABLE session_transcript_entries(messages_json TEXT NOT NULL);
      CREATE TABLE source_truth_spill_gc_queue(locator TEXT, session_id TEXT, status TEXT);
      CREATE TABLE source_truth_spill_gc_scan_state(root_key TEXT,status TEXT,after_name TEXT,attempts INTEGER,last_error TEXT);`)
    db.prepare('INSERT INTO agent_history_events(payload_json) VALUES(?)').run(JSON.stringify({ source: descriptor(sourceLocator, 'source-of-truth'), view: descriptor(degradableLocator, 'degradable') }))
    db.prepare("INSERT INTO source_truth_spill_gc_queue VALUES(?, '', 'pending')").run(orphanLocator)
    db.prepare("INSERT INTO source_truth_spill_gc_scan_state VALUES('user-data-spill','pending',NULL,2,'retry')").run()
    db.close()

    expect(collectSessionStorageProfile(dbPath)).toMatchObject({ spillFiles: {
      files: 3, totalBytes: 11, sourceOfTruthBytes: 4, degradableBytes: 5, orphanBytes: 2
    }, sourceTruthGc: { pendingFiles: 1, pendingBytes: 2, orphanBytes: 2, scanStatus: 'pending', attempts: 2, lastError: 'retry' } })
  })

  it('includes WAL and degradable spill in total storage usage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-profile-total-'))
    tempPaths.push(root)
    const dbPath = path.join(root, 'spaceassistant.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE padding(value TEXT NOT NULL)')
    db.prepare('INSERT INTO padding(value) VALUES(?)').run('p'.repeat(100_000))
    const spillRoot = path.join(root, 'spill-degraded')
    fs.mkdirSync(spillRoot)
    fs.writeFileSync(path.join(spillRoot, 'copy.spill'), Buffer.alloc(2048))
    const profile = collectSessionStorageProfile(dbPath) as any
    expect(profile.databaseFiles.dbBytes).toBeGreaterThan(0)
    expect(profile.databaseFiles.totalBytes).toBeGreaterThanOrEqual(profile.databaseFiles.dbBytes)
    expect(profile.spillDegraded.totalBytes).toBe(2048)
    expect(profile.totalBytes).toBeGreaterThanOrEqual(profile.databaseFiles.totalBytes + 2048)
    db.close()
  })
})
