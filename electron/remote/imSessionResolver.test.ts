import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, openDatabase } from '../database'
import { resolveImSession, truncateTitle } from './imSessionResolver'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-imsr-'))
}

describe('truncateTitle', () => {
  it('returns short titles unchanged', () => {
    expect(truncateTitle('hello')).toBe('hello')
  })

  it('truncates long titles with ellipsis', () => {
    expect(truncateTitle('abcdefghijklmnopqrstuvwxyz0123456789', 10)).toBe('abcdefghij…')
  })
})

describe('resolveImSession', () => {
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

  it('creates new session when none exists', async () => {
    const db = setupDb()
    const createNew = async (model: string) => {
      expect(model).toBe('m1')
      return createSession(db, { name: 'n', model }).id
    }
    const result = await resolveImSession({
      db,
      config: { remoteSessionIdleMinutes: 10 },
      defaultModel: 'm1',
      channel: 'feishu',
      identityKey: 'chat-1',
      getIdentityFromSession: (s) => (s.metadata as { feishuChatId?: string }).feishuChatId,
      createNew,
      onReuse: () => {
        throw new Error('should not reuse')
      }
    })
    expect(result.isNew).toBe(true)
  })

  it('reuses session within idle window', async () => {
    const db = setupDb()
    const existing = createSession(db, {
      name: 'old',
      metadata: {
        source: 'feishu',
        feishuChatId: 'chat-1',
        remoteSessionLastActivityAt: Date.now() - 3 * 60_000
      }
    })
    let reused = false
    const result = await resolveImSession({
      db,
      config: { remoteSessionIdleMinutes: 10 },
      defaultModel: 'm1',
      channel: 'feishu',
      identityKey: 'chat-1',
      getIdentityFromSession: (s) => (s.metadata as { feishuChatId?: string }).feishuChatId,
      createNew: async () => {
        throw new Error('should not create')
      },
      onReuse: (s) => {
        reused = true
        expect(s.id).toBe(existing.id)
      }
    })
    expect(result.isNew).toBe(false)
    expect(result.sessionId).toBe(existing.id)
    expect(reused).toBe(true)
  })

  it('creates new session after idle timeout', async () => {
    const db = setupDb()
    createSession(db, {
      name: 'old',
      metadata: {
        source: 'feishu',
        feishuChatId: 'chat-1',
        remoteSessionLastActivityAt: Date.now() - 11 * 60_000
      }
    })
    const result = await resolveImSession({
      db,
      config: { remoteSessionIdleMinutes: 10 },
      defaultModel: 'm1',
      channel: 'feishu',
      identityKey: 'chat-1',
      getIdentityFromSession: (s) => (s.metadata as { feishuChatId?: string }).feishuChatId,
      createNew: async () => 'new-id',
      onReuse: () => {
        throw new Error('should not reuse')
      }
    })
    expect(result).toEqual({ sessionId: 'new-id', isNew: true })
  })

  it('idleMinutes=0 always creates new session', async () => {
    const db = setupDb()
    createSession(db, {
      name: 'old',
      metadata: {
        source: 'feishu',
        feishuChatId: 'chat-1',
        remoteSessionLastActivityAt: Date.now()
      }
    })
    const result = await resolveImSession({
      db,
      config: { remoteSessionIdleMinutes: 0 },
      defaultModel: 'm1',
      channel: 'feishu',
      identityKey: 'chat-1',
      getIdentityFromSession: (s) => (s.metadata as { feishuChatId?: string }).feishuChatId,
      createNew: async () => 'forced-new',
      onReuse: () => {
        throw new Error('should not reuse')
      }
    })
    expect(result).toEqual({ sessionId: 'forced-new', isNew: true })
  })

  it('falls back when remoteDefaultModelId is not in available list', async () => {
    const db = setupDb()
    let usedModel = ''
    await resolveImSession({
      db,
      config: { remoteSessionIdleMinutes: 0, remoteDefaultModelId: 'missing' },
      defaultModel: 'fallback',
      availableModelNames: ['fallback', 'other'],
      channel: 'wechat',
      identityKey: 'u1',
      getIdentityFromSession: () => undefined,
      createNew: async (model) => {
        usedModel = model
        return 'id'
      },
      onReuse: () => undefined
    })
    expect(usedModel).toBe('fallback')
  })
})
