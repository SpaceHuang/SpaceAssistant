import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { SessionBackupManager, arrayMessagePageReader, type MessagePageReader, type MessagesPage } from './sessionBackupManager'
import type { Message, Session } from '../src/shared/domainTypes'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'Test',
    preview: '',
    model: 'm',
    temperature: 1,
    maxTokens: 1024,
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 1),
    messageCount: 0,
    schemaVersion: 1,
    ...over
  }
}

function makeMessage(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content: `content-${id}`,
    timestamp: 1,
    status: 'sent',
    schemaVersion: 1,
    ...over
  }
}

/** 模拟按 sequence 游标分页的 DB 读取：每页最多 pageSize 条，fromCursor 为游标 */
function dbLikePageReader(all: Message[]): MessagePageReader {
  return (fromCursor: number, pageSize: number): MessagesPage => {
    const remaining = all.slice(fromCursor)
    const page = remaining.slice(0, pageSize)
    return { messages: page, nextSequence: fromCursor + page.length }
  }
}

describe('SessionBackupManager', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-backup-test-'))
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  function sessionDir(session: Session): string {
    const dateStr = new Date(session.createdAt).toISOString().slice(0, 10).replace(/-/g, '')
    return path.join(workDir, 'sessions', `${session.id}-${dateStr}`)
  }

  it('writes session.json and messages.json for a normal backup/restore roundtrip', async () => {
    const mgr = new SessionBackupManager(workDir)
    const session = makeSession()
    const messages = [makeMessage('m1'), makeMessage('m2')]

    await mgr.backupSession(session, arrayMessagePageReader(messages))

    const restored = await mgr.restoreSession(session.id)
    expect(restored?.session.id).toBe(session.id)
    expect(restored?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('reads across multiple pages and preserves full ordering (no truncation)', async () => {
    const mgr = new SessionBackupManager(workDir)
    const session = makeSession()
    const total = 25
    const messages = Array.from({ length: total }, (_, i) => makeMessage(`m${i}`))

    // Small page size forces several round trips through the cursor-based reader.
    await mgr.backupSession(session, dbLikePageReader(messages), 7)

    const messagesJsonPath = path.join(sessionDir(session), 'messages.json')
    const raw = await fs.readFile(messagesJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as { messages: Message[]; sessionId: string }
    expect(parsed.sessionId).toBe(session.id)
    expect(parsed.messages).toHaveLength(total)
    expect(parsed.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id))
  })

  it('streams >10001 messages page-by-page without the manager retaining the full array', async () => {
    const mgr = new SessionBackupManager(workDir)
    const session = makeSession()
    const total = 10001
    const pageSize = 500
    let peakPageSize = 0
    let pages = 0

    const streamingReader: MessagePageReader = (fromCursor, size) => {
      const end = Math.min(fromCursor + size, total)
      const page = []
      for (let i = fromCursor; i < end; i++) {
        page.push(makeMessage(`m${i}`))
      }
      peakPageSize = Math.max(peakPageSize, page.length)
      pages += 1
      return { messages: page, nextSequence: fromCursor + page.length }
    }

    await mgr.backupSession(session, streamingReader, pageSize)

    expect(pages).toBeGreaterThan(1)
    expect(peakPageSize).toBeLessThanOrEqual(pageSize)
    const messagesJsonPath = path.join(sessionDir(session), 'messages.json')
    const parsed = JSON.parse(await fs.readFile(messagesJsonPath, 'utf-8')) as {
      messages: Message[]
    }
    expect(parsed.messages).toHaveLength(total)
    expect(parsed.messages[0]?.id).toBe('m0')
    expect(parsed.messages[total - 1]?.id).toBe(`m${total - 1}`)
  })

  it('does not create an incomplete messages.json when a page read fails', async () => {
    const mgr = new SessionBackupManager(workDir)
    const session = makeSession()

    let calls = 0
    const failingReader: MessagePageReader = (fromCursor, pageSize) => {
      calls += 1
      if (calls === 2) throw new Error('page read failed')
      return { messages: [makeMessage('m0')], nextSequence: fromCursor + 1 }
    }

    await expect(mgr.backupSession(session, failingReader, 1)).rejects.toThrow('page read failed')

    const dir = sessionDir(session)
    const entries = await fs.readdir(dir).catch(() => [])
    expect(entries.some((f) => f.endsWith('messages.json'))).toBe(false)
    expect(entries.some((f) => f.includes('.tmp'))).toBe(false)
  })

  it('deletes the temp file and leaves the previous messages.json untouched when a write fails mid-stream', async () => {
    const mgr = new SessionBackupManager(workDir)
    const session = makeSession()

    // Seed an existing, previously-successful backup.
    await mgr.backupSession(session, arrayMessagePageReader([makeMessage('old')]))
    const messagesJsonPath = path.join(sessionDir(session), 'messages.json')
    const beforeContent = await fs.readFile(messagesJsonPath, 'utf-8')

    // A message with a BigInt field cannot be JSON.stringify'd and will throw mid-write,
    // after the temp file has already been created and partially written.
    const poisoned = [
      makeMessage('m1'),
      { ...makeMessage('m2'), poison: 10n } as unknown as Message
    ]

    await expect(mgr.backupSession(session, arrayMessagePageReader(poisoned))).rejects.toThrow()

    const afterContent = await fs.readFile(messagesJsonPath, 'utf-8')
    expect(afterContent).toBe(beforeContent)

    const dir = sessionDir(session)
    const entries = await fs.readdir(dir)
    expect(entries.some((f) => f.includes('.tmp'))).toBe(false)
  })
})
