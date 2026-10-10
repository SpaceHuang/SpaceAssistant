import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const STORAGE_PROFILE_FIXTURE_VERSION = 1
export const STORAGE_PROFILE_FIXTURE_SEED = 20261010

export type StorageProfileFixtureSize = 'small' | 'medium' | 'large'

const FIXTURE_SIZES: Record<StorageProfileFixtureSize, { rows: number; payloadBytes: number; spillFiles: number }> = {
  small: { rows: 100, payloadBytes: 256, spillFiles: 10 },
  medium: { rows: 2_000, payloadBytes: 1_024, spillFiles: 200 },
  large: { rows: 20_000, payloadBytes: 4_096, spillFiles: 2_000 }
}

export function getStorageProfileFixtureSpec(size: StorageProfileFixtureSize) {
  return { version: STORAGE_PROFILE_FIXTURE_VERSION, seed: STORAGE_PROFILE_FIXTURE_SEED, size, ...FIXTURE_SIZES[size],
    schema: 'storage-profile-benchmark-v1', indexState: 'missing' as const }
}

export function createStorageProfileFixture(size: StorageProfileFixtureSize, root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-storage-profile-bench-'))) {
  const spec = getStorageProfileFixtureSpec(size)
  const dbPath = path.join(root, 'spaceassistant.db')
  const spillRoot = path.join(root, 'spill')
  fs.mkdirSync(spillRoot, { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, thinking TEXT, attachments TEXT, content_segments TEXT);
      CREATE TABLE agent_history_streams(invocation_id TEXT PRIMARY KEY, version INTEGER, schema_version INTEGER, session_id TEXT);
      CREATE TABLE agent_history_events(invocation_id TEXT, kind TEXT, payload_json TEXT);
      CREATE TABLE source_truth_spill_gc_queue(locator TEXT, session_id TEXT, status TEXT);
      CREATE TABLE source_truth_spill_gc_scan_state(root_key TEXT PRIMARY KEY,status TEXT,after_name TEXT,attempts INTEGER,last_error TEXT);`)
    const insertSession = db.prepare('INSERT INTO sessions VALUES(?, ?)')
    const insertMessage = db.prepare('INSERT INTO messages VALUES(?, ?, ?, ?, NULL, NULL, NULL, NULL)')
    const insertStream = db.prepare('INSERT INTO agent_history_streams VALUES(?, 1, 1, ?)')
    const insertEvent = db.prepare('INSERT INTO agent_history_events VALUES(?, ?, ?)')
    const payload = 'x'.repeat(spec.payloadBytes)
    const random = seededRandom(spec.seed)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (let i = 0; i < spec.rows; i += 1) {
        const id = `s-${i.toString(8)}-${Math.floor(random() * 0x1000000).toString(16)}`
        const invocation = `i-${i}`
        insertSession.run(id, `fixture-${i}`)
        insertMessage.run(`m-${i}`, id, 'assistant', payload)
        insertStream.run(invocation, id)
        insertEvent.run(invocation, 'model-response-committed', JSON.stringify({ message: { id: `m-${i}`, role: 'assistant', content: payload } }))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    for (let i = 0; i < spec.spillFiles; i += 1) {
      const locator = `${i.toString(16).padStart(8, '0')}.spill`
      fs.writeFileSync(path.join(spillRoot, locator), Buffer.alloc(128 + (i % 128), i % 251))
    }
  } finally {
    db.close()
  }
  return { root, dbPath, spec, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}
