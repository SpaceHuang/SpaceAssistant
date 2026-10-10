import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectSessionStorageOverview } from './sessionStorageProfile'
import * as spillStore from '../storage/spillStore'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function createDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-profile-overview-'))
  roots.push(root)
  const dbPath = path.join(root, 'spaceassistant.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY);
    CREATE TABLE messages(id TEXT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, thinking TEXT, attachments TEXT, content_segments TEXT);
    CREATE TABLE agent_history_streams(invocation_id TEXT,session_id TEXT);
    CREATE TABLE agent_history_events(invocation_id TEXT,kind TEXT,payload_json TEXT);
    CREATE TABLE session_transcript_entries(messages_json TEXT);
    INSERT INTO sessions VALUES('s');
    INSERT INTO messages VALUES('m','s','assistant','ordinary body',NULL,NULL,NULL,NULL);
    INSERT INTO agent_history_streams VALUES('i','s');
    INSERT INTO agent_history_events VALUES('i','model-response-committed','{not-valid-json');
    INSERT INTO session_transcript_entries VALUES('{not-valid-json');`)
  db.close()
  return { root, dbPath }
}

describe('collectSessionStorageOverview', () => {
  it('does not invoke the strict spill scanner or parse history/transcript JSON bodies', () => {
    const fixture = createDb()
    const strictScan = vi.spyOn(spillStore, 'readCanonicalSpillReferences')
    const overview = collectSessionStorageOverview(fixture.dbPath)
    expect(strictScan.mock.calls.length).toBe(0)
    expect(overview.status).toBe('partial')
    expect(overview.spill.classification).toBe('unknown')
    expect(overview.spill.sourceOfTruthBytes).toBeNull()
    expect(overview.spill.degradableBytes).toBeNull()
    expect(overview.spill.orphanBytes).toBeNull()
  })

  it('uses only a complete, versioned, generation-matched spill index', () => {
    const fixture = createDb()
    const spillRoot = path.join(fixture.root, 'spill')
    fs.mkdirSync(spillRoot)
    fs.writeFileSync(path.join(spillRoot, 'source.spill'), 'source')
    fs.writeFileSync(path.join(spillRoot, 'degradable.spill'), 'copy')
    const db = new DatabaseSync(fixture.dbPath)
    db.exec(`CREATE TABLE spill_reference_backfill_state(owner_table TEXT,status TEXT,protocol_version INTEGER,verified_generation INTEGER);
      CREATE TABLE spill_reference_meta(meta_key TEXT,meta_value INTEGER);
      CREATE TABLE spill_reference_index(owner_table TEXT,owner_key TEXT,descriptor_path TEXT,locator TEXT,kind TEXT);
      INSERT INTO spill_reference_backfill_state VALUES('agent_history_events','complete',1,7),('session_transcript_entries','complete',1,7);
      INSERT INTO spill_reference_meta VALUES('canonical_change_generation',7);
      INSERT INTO spill_reference_index VALUES('agent_history_events','e','source','source.spill','source-of-truth'),('session_transcript_entries','t','copy','degradable.spill','degradable');`)
    db.close()
    const strictScan = vi.spyOn(spillStore, 'readCanonicalSpillReferences')

    const overview = collectSessionStorageOverview(fixture.dbPath)

    expect(strictScan.mock.calls.length).toBe(0)
    expect(overview.spill).toMatchObject({ classification: 'complete', sourceOfTruthBytes: 6, degradableBytes: 4, orphanBytes: 0, observedBytes: 10 })
    expect(overview.totalBytes).toEqual(expect.any(Number))
  })

  it.each([
    ['incomplete backfill', "UPDATE spill_reference_backfill_state SET status='pending'"],
    ['wrong protocol', 'UPDATE spill_reference_backfill_state SET protocol_version=2'],
    ['generation mismatch', 'UPDATE spill_reference_backfill_state SET verified_generation=6']
  ])('returns unknown classification for %s', (_label, update) => {
    const fixture = createDb()
    const db = new DatabaseSync(fixture.dbPath)
    db.exec(`CREATE TABLE spill_reference_backfill_state(owner_table TEXT,status TEXT,protocol_version INTEGER,verified_generation INTEGER);
      CREATE TABLE spill_reference_meta(meta_key TEXT,meta_value INTEGER);
      CREATE TABLE spill_reference_index(owner_table TEXT,owner_key TEXT,descriptor_path TEXT,locator TEXT,kind TEXT);
      INSERT INTO spill_reference_backfill_state VALUES('agent_history_events','complete',1,7),('session_transcript_entries','complete',1,7);
      INSERT INTO spill_reference_meta VALUES('canonical_change_generation',7); ${update};`)
    db.close()
    const strictScan = vi.spyOn(spillStore, 'readCanonicalSpillReferences')

    const overview = collectSessionStorageOverview(fixture.dbPath)

    expect(strictScan.mock.calls.length).toBe(0)
    expect(overview.spill).toMatchObject({ classification: 'unknown', sourceOfTruthBytes: null, degradableBytes: null, orphanBytes: null })
    expect(overview.totalBytes).toBeNull()
  })

  it('reports physical observed spill bytes when a symlink makes classification incomplete', () => {
    const fixture = createDb()
    const spillRoot = path.join(fixture.root, 'spill')
    fs.mkdirSync(spillRoot)
    fs.writeFileSync(path.join(spillRoot, 'physical.spill'), 'physical-bytes')
    fs.symlinkSync(path.join(spillRoot, 'physical.spill'), path.join(spillRoot, 'link.spill'))

    const overview = collectSessionStorageOverview(fixture.dbPath)

    expect(overview.spill.observedBytes).toBeGreaterThanOrEqual(Buffer.byteLength('physical-bytes'))
    expect(overview.spill.totalBytes).toBeNull()
    expect(overview.spill.complete).toBe(false)
    expect(overview.totalBytes).toBeNull()
    expect(overview.spill.errorCodes).toContain('SPILL_ENTRY_NOT_REGULAR_FILE')
  })

  it.each(['missing', 'regular-file', 'symlink-root', 'permission-denied'] as const)('reports a partial physical inventory for a %s root', (caseName) => {
    const fixture = createDb()
    const spillRoot = path.join(fixture.root, 'spill')
    if (caseName === 'regular-file') fs.writeFileSync(spillRoot, 'not a directory')
    if (caseName === 'symlink-root') {
      fs.mkdirSync(path.join(fixture.root, 'spill-target'))
      fs.symlinkSync(path.join(fixture.root, 'spill-target'), spillRoot)
    }
    if (caseName === 'permission-denied') {
      fs.mkdirSync(spillRoot)
      fs.chmodSync(spillRoot, 0)
      vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error })
    }

    let overview: ReturnType<typeof collectSessionStorageOverview>
    try { overview = collectSessionStorageOverview(fixture.dbPath) }
    finally { if (caseName === 'permission-denied') fs.chmodSync(spillRoot, 0o700) }

    if (caseName === 'missing') expect(overview!.spill.totalBytes).toBe(0)
    else {
      expect(overview!.spill.totalBytes).toBeNull()
      expect(overview!.spill.complete).toBe(false)
      if (caseName === 'regular-file' || caseName === 'symlink-root') expect(overview!.spill.errorCodes).toContain('SPILL_ROOT_NOT_DIRECTORY')
      if (caseName === 'permission-denied') expect(overview!.spill.errorCodes).toContain('EACCES')
    }
  })

  it('keeps bytes observed before a file disappears during lstat', () => {
    const fixture = createDb()
    const spillRoot = path.join(fixture.root, 'spill')
    fs.mkdirSync(spillRoot)
    fs.writeFileSync(path.join(spillRoot, 'observed.spill'), 'observed')
    fs.writeFileSync(path.join(spillRoot, 'vanishes.spill'), 'vanishes')
    const originalLstat = fs.lstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation(((filePath: Parameters<typeof fs.lstatSync>[0], ...args: unknown[]) => {
      if (String(filePath).endsWith('vanishes.spill')) { const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error }
      return (originalLstat as (...params: unknown[]) => ReturnType<typeof fs.lstatSync>)(filePath, ...args)
    }) as typeof fs.lstatSync)

    const overview = collectSessionStorageOverview(fixture.dbPath)

    expect(overview.spill.observedBytes).toBe(Buffer.byteLength('observed'))
    expect(overview.spill.totalBytes).toBeNull()
    expect(overview.spill.errorCodes).toContain('ENOENT')
  })
})
