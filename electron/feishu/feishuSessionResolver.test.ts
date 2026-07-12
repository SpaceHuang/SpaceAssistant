import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, openDatabase, updateSession } from '../database'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { resolveFeishuSession } from './feishuSessionResolver'

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
    const result = await resolveFeishuSession(db, makeMsg(), config, 'model')
    expect(result.isNew).toBe(false)
    expect(result.sessionId).toBe(existing.id)
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
    const result = await resolveFeishuSession(db, makeMsg(), config, 'model')
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
    const result = await resolveFeishuSession(db, makeMsg(), config, 'model')
    expect(result.isNew).toBe(true)
  })
})
