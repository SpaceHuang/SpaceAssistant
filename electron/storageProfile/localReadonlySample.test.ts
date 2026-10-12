import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { sampleLocalStorageReadonly } from './localReadonlySample'

function tempDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-local-profile-test-'))
  const dbPath = path.join(root, 'spaceassistant-data.db')
  const db = new DatabaseSync(dbPath)
  db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('private fixture body')")
  db.close()
  return { root, dbPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const overview = { type: 'overview' as const, result: { collectedAt: '2026-10-10T00:00:00Z', status: 'partial', database: { dbBytes: 4096, walBytes: 0 }, tables: { messages: { rows: 3 } }, spill: { classification: 'unknown', files: 0, observedBytes: 0, complete: false, errorCodes: ['SPILL_REFERENCE_INDEX_UNAVAILABLE'] } } }

describe('sampleLocalStorageReadonly', () => {
  it('fails closed for missing and ambiguous canonical candidates', async () => {
    await expect(sampleLocalStorageReadonly({ candidates: [] })).resolves.toMatchObject({ status: 'skipped', reason: 'missing' })
    await expect(sampleLocalStorageReadonly({ candidates: ['/one.db', '/two.db'] })).resolves.toMatchObject({ status: 'skipped', reason: 'ambiguous' })
  })

  it('dry-runs the unique regular database with a redacted identity only', async () => {
    const fixture = tempDb()
    try {
      const result = await sampleLocalStorageReadonly({ candidates: [fixture.dbPath], dryRun: true })
      expect(result).toMatchObject({ status: 'ready', dbBytes: expect.any(Number), identity: expect.stringMatching(/^[a-f0-9]{16}$/) })
      expect(JSON.stringify(result)).not.toContain(fixture.root)
    } finally { fixture.cleanup() }
  })

  it('skips symlinks, corrupt databases and permission failures without exposing paths', async () => {
    const fixture = tempDb()
    const link = path.join(fixture.root, 'link.db')
    const corrupt = path.join(fixture.root, 'corrupt.db')
    fs.symlinkSync(fixture.dbPath, link)
    fs.writeFileSync(corrupt, 'not sqlite')
    try {
      await expect(sampleLocalStorageReadonly({ candidates: [link] })).resolves.toMatchObject({ status: 'skipped', reason: 'symlink' })
      await expect(sampleLocalStorageReadonly({ candidates: [corrupt] })).resolves.toMatchObject({ status: 'skipped', reason: 'unreadable-or-corrupt' })
      await expect(sampleLocalStorageReadonly({ candidates: [fixture.dbPath], inspect: () => { const error = new Error('secret path'); (error as NodeJS.ErrnoException).code = 'EACCES'; throw error } })).resolves.toMatchObject({ status: 'skipped', reason: 'permission-denied' })
    } finally { fixture.cleanup() }
  })

  it('records only allowlisted overview counts and marks concurrent external writes inconclusive', async () => {
    const fixture = tempDb()
    const before = fs.statSync(fixture.dbPath)
    const after = { ...before, mtimeMs: before.mtimeMs + 1 }
    let calls = 0
    try {
      const result = await sampleLocalStorageReadonly({ candidates: [fixture.dbPath], runOverview: vi.fn().mockResolvedValue(overview),
        inspect: () => ({ dbPath: fixture.dbPath, stat: ++calls === 1 ? before : after }) })
      expect(result).toMatchObject({ sampleStatus: 'concurrent-change/inconclusive', rowCounts: { messages: 3 }, spill: { classification: 'unknown', complete: false }, errorCodes: ['SPILL_REFERENCE_INDEX_UNAVAILABLE'] })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('private fixture body')
      expect(serialized).not.toContain(fixture.root)
      expect(serialized).not.toContain('dbPath')
    } finally { fixture.cleanup() }
  })

  it('leaves the fixture database contents unchanged during read-only sampling', async () => {
    const fixture = tempDb()
    const read = () => { const db = new DatabaseSync(fixture.dbPath, { readOnly: true }); try { return db.prepare('SELECT value FROM sample').get()?.value } finally { db.close() } }
    const before = read()
    try {
      const result = await sampleLocalStorageReadonly({ candidates: [fixture.dbPath], runOverview: async () => overview })
      expect(result.sampleStatus).toBe('sampled')
      expect(read()).toBe(before)
    } finally { fixture.cleanup() }
  })

  it('classifies an independent writer commit during sampling as inconclusive', async () => {
    const fixture = tempDb()
    const writer = new DatabaseSync(fixture.dbPath)
    writer.exec('PRAGMA journal_mode=WAL')
    let committed = false
    try {
      const result = await sampleLocalStorageReadonly({ candidates: [fixture.dbPath], runOverview: async () => {
        writer.prepare('INSERT INTO sample(value) VALUES(?)').run('concurrent external write')
        committed = true
        return overview
      } })
      expect(committed).toBe(true)
      expect(result.sampleStatus).toBe('concurrent-change/inconclusive')
    } finally { writer.close(); fixture.cleanup() }
  })
})
