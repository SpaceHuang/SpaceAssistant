import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openDatabase,
  getSessionUsage,
  setSessionUsage,
  deleteSessionUsage,
  getAllSessionUsages,
  deleteSession,
  createSession,
  type AppDatabase
} from './database'
import { createTempDatabase } from './database/testHelpers'

describe('sessionUsages persistence', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-usage-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('returns undefined when no usage stored', () => {
    expect(getSessionUsage(db, 'missing')).toBeUndefined()
  })

  it('persists and reads usage per session', () => {
    const usage = { input_tokens: 50_000, output_tokens: 3000, cache_read_input_tokens: 100_000 }
    setSessionUsage(db, 's1', usage)
    expect(getSessionUsage(db, 's1')).toEqual(usage)
  })

  it('getAllSessionUsages returns a copy', () => {
    setSessionUsage(db, 's1', { input_tokens: 100 })
    setSessionUsage(db, 's2', { input_tokens: 200 })
    const all = getAllSessionUsages(db)
    expect(all).toEqual({
      s1: { input_tokens: 100 },
      s2: { input_tokens: 200 }
    })
    all.s1 = { input_tokens: 999 }
    expect(getSessionUsage(db, 's1')?.input_tokens).toBe(100)
  })

  it('deleteSessionUsage removes one entry', () => {
    setSessionUsage(db, 's1', { input_tokens: 100 })
    deleteSessionUsage(db, 's1')
    expect(getSessionUsage(db, 's1')).toBeUndefined()
  })

  it('deleteSession clears sessionUsages for that session', () => {
    const session = createSession(db, { name: 'test' })
    setSessionUsage(db, session.id, { input_tokens: 5000 })
    deleteSession(db, session.id)
    expect(getSessionUsage(db, session.id)).toBeUndefined()
  })

  it('loads legacy db without sessionUsages field via JSON migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-legacy-'))
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ sessions: [], messages: [], configs: {}, searchHistory: [] }),
      'utf8'
    )

    const legacyDb = openDatabase(path.join(dir, 'spaceassistant-data.db'))
    setSessionUsage(legacyDb, 's1', { input_tokens: 42 })
    expect(getSessionUsage(legacyDb, 's1')).toEqual({ input_tokens: 42 })
    expect(fs.existsSync(jsonPath)).toBe(false)
    legacyDb.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
