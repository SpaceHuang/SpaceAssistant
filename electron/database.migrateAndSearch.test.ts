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
  listSearchHistory,
  openDatabase,
  searchMessages
} from './database'
import { migrateFromJsonIfNeeded } from './database/migrateFromJson'
import { getDbConnection, getSchemaMeta, openSqliteDatabase } from './database/sqliteStore'
import { SCHEMA_META_KEYS } from './database/schema'
import { cleanupLegacyWorkspaceLayoutOnStartup } from './database/legacyWorkspaceLayoutCleanup'

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

  it('导入中途约束错误：整体回滚，前序写入/版本标记均不落盘，JSON 不重命名', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-atomic-'))
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
      messageCount: 2,
      skillsState: { enabledSkillNames: [], disabledSkillNames: [] },
      metadata: {},
      schemaVersion: 1,
      workDirProfileId: 'default'
    }
    const message = (id: string, sequence: number) => ({
      id,
      sessionId: 'sess-1',
      role: 'user',
      content: `msg ${id}`,
      toolUse: null,
      toolCalls: null,
      thinking: null,
      status: 'sent',
      schemaVersion: 1,
      timestamp: 1,
      sequence
    })

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        sessions: [session],
        // 第二条消息与第一条主键冲突：在 configs/sessions 已写入后触发约束错误
        messages: [message('m1', 0), message('m1', 1)],
        configs: {
          'config.locale': { value: 'zh-CN', createdAt: 1, updatedAt: 1 }
        },
        searchHistory: [],
        sessionUsages: {}
      }),
      'utf8'
    )

    const db = openSqliteDatabase(dbPath)
    expect(() => migrateFromJsonIfNeeded(db, jsonPath)).toThrow(/JSON migration failed/)

    const conn = getDbConnection(db)
    const count = (table: string) => (conn.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
    expect(count('configs')).toBe(0)
    expect(count('sessions')).toBe(0)
    expect(count('messages')).toBe(0)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.migratedFromJsonAt)).toBeUndefined()
    // 源 JSON 未重命名，可修复后重试
    expect(fs.existsSync(jsonPath)).toBe(true)
    db.close()

    // 修复数据后重试成功（幂等可重入）
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        sessions: [session],
        messages: [message('m1', 0)],
        configs: { 'config.locale': { value: 'zh-CN', createdAt: 1, updatedAt: 1 } },
        searchHistory: [],
        sessionUsages: {}
      }),
      'utf8'
    )
    const db2 = openDatabase(dbPath)
    expect(getMessages(db2, 'sess-1')).toHaveLength(1)
    db2.close()
  })

  it('recovers orphan messages by creating placeholder sessions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-orphan-'))
    dirs.push(dir)
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    const dbPath = path.join(dir, 'spaceassistant-data.db')

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        sessions: [],
        messages: [
          {
            id: 'm-orphan',
            sessionId: 'sess-missing',
            role: 'user',
            content: 'orphan message',
            toolUse: null,
            toolCalls: null,
            thinking: null,
            status: 'sent',
            schemaVersion: 1,
            timestamp: 100,
            sequence: 0
          }
        ],
        configs: {},
        searchHistory: []
      }),
      'utf8'
    )

    const db = openDatabase(dbPath)
    expect(getSession(db, 'sess-missing')?.name).toBe('(迁移恢复)')
    expect(getMessages(db, 'sess-missing')).toHaveLength(1)
    db.close()
  })

  it('accepts legacy session_id field on messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-legacy-field-'))
    dirs.push(dir)
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    const dbPath = path.join(dir, 'spaceassistant-data.db')

    const session = {
      id: 'sess-legacy',
      name: 'legacy',
      preview: '',
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      maxTokens: 4096,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 1,
      skillsState: { manualActivated: [], manualDisabled: [] },
      metadata: {},
      schemaVersion: 1
    }

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        sessions: [session],
        messages: [
          {
            id: 'm-legacy',
            session_id: 'sess-legacy',
            role: 'user',
            content: 'legacy field',
            status: 'sent',
            schemaVersion: 1,
            timestamp: 1,
            sequence: 0
          }
        ],
        configs: {},
        searchHistory: []
      }),
      'utf8'
    )

    const db = openDatabase(dbPath)
    expect(getMessages(db, 'sess-legacy')).toHaveLength(1)
    db.close()
  })

  it('归一历史快照（评审 C2）：searchHistory 多余字段与缺失可选字段的消息可一次性迁移', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-normalize-'))
    dirs.push(dir)
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    const dbPath = path.join(dir, 'spaceassistant-data.db')

    const session = {
      id: 'sess-n1',
      name: 'normalize',
      preview: '',
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      maxTokens: 4096,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 1,
      skillsState: { enabledSkillNames: [], disabledSkillNames: [] },
      metadata: {},
      schemaVersion: 1
    }

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        sessions: [session],
        messages: [
          {
            id: 'm-n1',
            sessionId: 'sess-n1',
            role: 'user',
            content: 'legacy minimal message',
            // 全部可空列缺失（旧 JSON 无这些键），且携带历史遗留未知字段
            legacyUnknownField: 'should-be-dropped',
            status: 'sent',
            schemaVersion: 1,
            timestamp: 1,
            sequence: 0
          }
        ],
        configs: {},
        searchHistory: [
          // 历史遗留多余字段：node:sqlite 对多余命名参数键直接抛 Unknown named parameter
          { id: 'h-n1', query: 'legacy query', timestamp: 1, source: 'legacy-panel', extraField: { a: 1 } }
        ],
        sessionUsages: {}
      }),
      'utf8'
    )

    const db = openDatabase(dbPath)
    const messages = getMessages(db, 'sess-n1')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe('legacy minimal message')
    expect(listSearchHistory(db)).toEqual(['legacy query'])
    db.close()
  })

  it('does not migrate when SQLite already has data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-skip-'))
    dirs.push(dir)
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    const dbPath = path.join(dir, 'spaceassistant-data.db')

    fs.writeFileSync(jsonPath, JSON.stringify({ sessions: [], messages: [], configs: {}, searchHistory: [] }), 'utf8')

    const db = openSqliteDatabase(dbPath)
    createSession(db, { name: 'existing' })
    db.close()

    const db2 = openDatabase(dbPath)
    const result = migrateFromJsonIfNeeded(db2, jsonPath)
    expect(result).toBeNull()
    expect(fs.existsSync(jsonPath)).toBe(true)
    db2.close()
  })

  it('strips workspaceLayout config when importing JSON after cleanup marker exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-migrate-legacy-layout-'))
    dirs.push(dir)
    const jsonPath = path.join(dir, 'spaceassistant-data.json')
    const dbPath = path.join(dir, 'spaceassistant-data.db')

    // First boot: empty SQLite, cleanup writes completion marker (no sessions/configs yet).
    const db1 = openSqliteDatabase(dbPath)
    const cleaned = cleanupLegacyWorkspaceLayoutOnStartup(db1)
    expect(cleaned.ok).toBe(true)
    expect(getSchemaMeta(getDbConnection(db1), SCHEMA_META_KEYS.legacyWorkspaceLayoutCleanedAt)).toBeTruthy()
    db1.close()

    // Later: drop a legacy JSON beside the already-cleaned DB.
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        sessions: [
          {
            id: 'sess-legacy',
            name: 'from-json',
            preview: '',
            model: 'claude-sonnet-4-20250514',
            temperature: 0.7,
            maxTokens: 4096,
            createdAt: 1,
            updatedAt: 2,
            messageCount: 0,
            skillsState: { enabledSkillNames: [], disabledSkillNames: [] },
            metadata: {
              writeDirChoice: { dir: '/tmp/legacy', confirmedAt: 1 },
              keep: true
            },
            schemaVersion: 1
          }
        ],
        messages: [],
        configs: {
          'config.locale': { value: 'zh-CN', createdAt: 1, updatedAt: 1 },
          'config.workspaceLayout': {
            value: JSON.stringify({ enabled: true, writeDirConfirmEnabled: true, extensionSubdirMap: [] }),
            createdAt: 1,
            updatedAt: 1
          }
        },
        searchHistory: []
      }),
      'utf8'
    )

    const db2 = openSqliteDatabase(dbPath)
    const result = migrateFromJsonIfNeeded(db2, jsonPath)
    expect(result).not.toBeNull()
    expect(result?.sessions).toBe(1)

    // Startup cleanup would skip because marker already exists — import strips config only.
    expect(cleanupLegacyWorkspaceLayoutOnStartup(db2)).toEqual({ ok: true, skipped: true })
    expect(getSession(db2, 'sess-legacy')?.metadata.writeDirChoice).toBeDefined()
    expect(getSession(db2, 'sess-legacy')?.metadata.keep).toBe(true)
    expect(getSession(db2, 'sess-legacy')?.metadata.artifactDefaultDir).toBeUndefined()
    expect(getConfigValue(db2, 'config.workspaceLayout')).toBeUndefined()
    expect(getConfigValue(db2, 'config.locale')).toBe('zh-CN')
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

