import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, getSession, openDatabase } from '../database'
import { createWorkDirManager } from '../workDirManager'
import { mergeWeChatConfig } from '../../src/shared/wechatTypes'
import type { WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { resolveWeChatSession } from './weChatSessionResolver'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-wcsr-'))
}

function makeMsg(overrides: Partial<WeChatInboundMessage> = {}): WeChatInboundMessage {
  return {
    messageId: 'msg-1',
    userId: 'user-1',
    text: 'hello',
    type: 'text',
    contextToken: 'ctx-1',
    ...overrides
  }
}

describe('resolveWeChatSession workDirProfileId', () => {
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

  function setup() {
    const dir = tempDir()
    dirs.push(dir)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dir,
      setWorkDir: () => undefined
    })
    const profile = manager.addProfile({ name: 'Main', path: dir })
    return { db, activeProfileId: profile.profile!.id }
  }

  it('writes workDirProfileId on new session', async () => {
    const { db, activeProfileId } = setup()
    const config = mergeWeChatConfig({ remoteSessionMergeMinutes: 0 })
    const { sessionId } = await resolveWeChatSession(
      db,
      makeMsg(),
      config,
      'claude-sonnet-4-20250514',
      undefined,
      () => activeProfileId
    )
    expect(getSession(db, sessionId)?.workDirProfileId).toBe(activeProfileId)
  })

  it('backfills workDirProfileId when merging session without binding', async () => {
    const { db, activeProfileId } = setup()
    const config = mergeWeChatConfig({ remoteSessionMergeMinutes: 60 })
    const existing = createSession(db, {
      name: '[微信] old',
      metadata: {
        source: 'wechat',
        wechatMeta: {
          userId: 'user-1',
          lastReplyAt: Date.now()
        }
      }
    })

    const { sessionId, isNew } = await resolveWeChatSession(
      db,
      makeMsg({ messageId: 'm2' }),
      config,
      'claude-sonnet-4-20250514',
      undefined,
      () => activeProfileId
    )

    expect(isNew).toBe(false)
    expect(sessionId).toBe(existing.id)
    expect(getSession(db, sessionId)?.workDirProfileId).toBe(activeProfileId)
  })
})
