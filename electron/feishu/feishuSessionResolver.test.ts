import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession, getSession, openDatabase } from '../database'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { resolveFeishuSession } from './feishuSessionResolver'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-fsr-'))
}

function makeMsg(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderOpenId: 'u1',
    content: 'hello',
    createTime: '1',
    mentionsBot: false,
    ...overrides
  }
}

describe('resolveFeishuSession idle resume', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function setupDb() {
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    return db
  }

  it('reuses session within idle window', async () => {
    const db = setupDb()
    const config = mergeFeishuConfig({ remoteSessionIdleMinutes: 10 })
    const existing = createSession(db, {
      name: 'old',
      metadata: {
        source: 'feishu',
        feishuChatId: 'chat-1',
        remoteSessionLastActivityAt: Date.now() - 3 * 60_000
      }
    })
    const result = await resolveFeishuSession(createSqliteSessionStorage(db), makeMsg({ messageId: 'msg-2' }), config, 'model')
    expect(result.isNew).toBe(false)
    expect(result.sessionId).toBe(existing.id)
    expect((getSession(db, existing.id)?.metadata as { feishuMessageId?: string }).feishuMessageId).toBe('msg-2')
  })

  it('uses the injected query and command ports when reusing a session', async () => {
    const db = setupDb()
    const config = mergeFeishuConfig({ remoteSessionIdleMinutes: 10 })
    const existing = createSession(db, {
      name: 'old',
      metadata: { source: 'feishu', feishuChatId: 'chat-1', remoteSessionLastActivityAt: Date.now() }
    })
    const storage = createSqliteSessionStorage(db)
    const listSessions = vi.fn(storage.queries.listSessions)
    const recordIdentity = vi.fn(storage.commands.recordRemoteSessionIdentity)
    const injected = {
      ...storage,
      queries: { ...storage.queries, listSessions },
      commands: { ...storage.commands, recordRemoteSessionIdentity: recordIdentity }
    }

    const result = await resolveFeishuSession(injected, makeMsg({ messageId: 'msg-injected' }), config, 'model')

    expect(result).toEqual({ sessionId: existing.id, isNew: false })
    expect(listSessions).toHaveBeenCalledOnce()
    expect(recordIdentity).toHaveBeenCalledWith(existing.id, { channel: 'feishu', messageId: 'msg-injected' })
  })

  it('creates new session after idle timeout', async () => {
    const db = setupDb()
    const config = mergeFeishuConfig({ remoteSessionIdleMinutes: 10 })
    createSession(db, {
      name: 'old',
      metadata: {
        source: 'feishu',
        feishuChatId: 'chat-1',
        remoteSessionLastActivityAt: Date.now() - 11 * 60_000
      }
    })
    const result = await resolveFeishuSession(createSqliteSessionStorage(db), makeMsg(), config, 'model')
    expect(result.isNew).toBe(true)
  })

  it('idleMinutes=0 always creates new session', async () => {
    const db = setupDb()
    const config = mergeFeishuConfig({ remoteSessionIdleMinutes: 0 })
    createSession(db, {
      name: 'old',
      metadata: {
        source: 'feishu',
        feishuChatId: 'chat-1',
        remoteSessionLastActivityAt: Date.now()
      }
    })
    const result = await resolveFeishuSession(createSqliteSessionStorage(db), makeMsg(), config, 'model')
    expect(result.isNew).toBe(true)
  })
})
