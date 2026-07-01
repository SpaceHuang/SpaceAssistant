import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendMessage,
  createSession,
  getConfigValue,
  getMessages,
  getSession,
  openDatabase,
  searchMessages
} from './database'
import { migrateFromJsonIfNeeded } from './database/migrateFromJson'
import { getSchemaMeta } from './database/sqliteStore'
import { SCHEMA_META_KEYS } from './database/schema'

describe('migrateFromJson', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('imports JSON snapshot into SQLite and renames source file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-'))
    dirs.push(dir)
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    const dbPath = path.join(dir, 'spaceassistant-data.db')

    const session = {
      id: 'sess-1',
      name: 'hello',
      preview: 'hi',
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      maxTokens: 4096,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      skillsState: { enabledSkillNames: [], disabledSkillNames: [] },
      metadata: {},
      schemaVersion: 1,
      workDirProfileId: 'default'
    }

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        sessions: [session],
        messages: [
          {
            id: 'm1',
            sessionId: 'sess-1',
            role: 'user',
            content: 'hello world',
            toolUse: null,
            toolCalls: null,
            thinking: null,
            status: 'sent',
            schemaVersion: 1,
            timestamp: 1,
            sequence: 0
          }
        ],
        configs: {
          'config.locale': { value: 'zh-CN', createdAt: 1, updatedAt: 1 }
        },
        searchHistory: [{ id: 'h1', query: 'test', timestamp: 1 }],
        sessionUsages: { 'sess-1': { input_tokens: 10 } }
      }),
      'utf8'
    )

    const db = openDatabase(dbPath)
    expect(getSession(db, 'sess-1')?.name).toBe('hello')
    expect(getMessages(db, 'sess-1')).toHaveLength(1)
    expect(getConfigValue(db, 'config.locale')).toBe('zh-CN')
    expect(getSchemaMeta(getDbConnection(db), SCHEMA_META_KEYS.migratedFromJsonAt)).toBeTruthy()
    expect(fs.existsSync(jsonPath)).toBe(false)
    db.close()
  })

  it('does not migrate when SQLite already has data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-skip-'))
    dirs.push(dir)
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    const dbPath = path.join(dir, 'spaceassistant-data.db')

    fs.writeFileSync(jsonPath, JSON.stringify({ sessions: [], messages: [], configs: {}, searchHistory: [] }), 'utf8')

    const db = openDatabase(dbPath)
    createSession(db, { name: 'existing' })
    db.close()

    const db2 = openDatabase(dbPath)
    const result = migrateFromJsonIfNeeded(db2, jsonPath)
    expect(result).toBeNull()
    expect(fs.existsSync(jsonPath)).toBe(true)
    db2.close()
  })
})

describe('searchMessages', () => {
  it('filters by active work dir profile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-search-'))
    const dbPath = path.join(dir, 'test.db')
    const db = openDatabase(dbPath)

    const s1 = createSession(db, { name: 'A', workDirProfileId: 'profile-a' })
    const s2 = createSession(db, { name: 'B', workDirProfileId: 'profile-b' })
    appendMessage(db, {
      id: 'm1',
      sessionId: s1.id,
      role: 'user',
      content: 'React performance tips',
      timestamp: 1,
      status: 'sent'
    })
    appendMessage(db, {
      id: 'm2',
      sessionId: s2.id,
      role: 'user',
      content: 'React hooks guide',
      timestamp: 2,
      status: 'sent'
    })

    const hits = searchMessages(db, 'React', 'profile-a', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe(s1.id)

    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

import { getDbConnection } from './database/sqliteStore'
