import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { createMemoryAppDb } from '../../database/testHelpers'
import { appendMessage, createSession, listSessions, getMessagesPage } from '../../database/operations'
import type { AppDatabase } from '../../database'
import { createSessionCapabilities } from './session'
import {
  registerSessionActiveStream,
  clearSessionActiveStream,
  clearAllSessionActiveStreamsForTest
} from '../../chatActiveStreams'
import type { CapabilityContext } from '../types'

let db: AppDatabase

function ctx(overrides?: Partial<CapabilityContext>): CapabilityContext {
  return {
    workDir: '/work',
    userDataDir: '/user',
    sessionId: 'current',
    requestId: 'r1',
    signal: new AbortController().signal,
    appDatabase: db,
    ...overrides
  }
}

function findCap(id: string) {
  const cap = createSessionCapabilities().find((c) => c.id === id)
  if (!cap) throw new Error(`missing capability ${id}`)
  return cap
}

beforeEach(() => {
  clearAllSessionActiveStreamsForTest()
  db = createMemoryAppDb()
})

async function seedSession(name: string, messageTexts: string[] = []): Promise<string> {
  const s = createSession(db, { name })
  for (const text of messageTexts) {
    appendMessage(db, {
      id: randomUUID(),
      sessionId: s.id,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'completed'
    })
  }
  return s.id
}

describe('action.session.list', () => {
  it('分页枚举：默认 20 条、limit 上限 50、返回紧凑字段与 nextOffset', async () => {
    for (let i = 0; i < 60; i++) {
      await seedSession(`会话 ${i}`)
    }
    const list = findCap('action.session.list')
    const page1 = (await list.handler({}, ctx())) as {
      sessions: Array<{ id: string; name: string; updatedAt: number; running: boolean }>
      total: number
      nextOffset: number
    }
    expect(page1.sessions).toHaveLength(20)
    expect(page1.total).toBe(60)
    expect(page1.nextOffset).toBe(20)
    expect(page1.sessions[0]).toMatchObject({ name: expect.any(String), running: false })
    expect(Object.keys(page1.sessions[0]!).sort()).toEqual(['id', 'name', 'running', 'updatedAt'].sort())

    const page3 = (await list.handler({ offset: 40, limit: 20 }, ctx())) as { sessions: unknown[]; nextOffset: number }
    expect(page3.sessions).toHaveLength(20)

    const overLimit = (await list.handler({ limit: 500 }, ctx())) as { sessions: unknown[] }
    expect(overLimit.sessions).toHaveLength(50)
  })

  it('运行中标志来自活跃流登记', async () => {
    const id = await seedSession('运行中的会话')
    registerSessionActiveStream(id, 'req-1')
    const list = findCap('action.session.list')
    const page = (await list.handler({}, ctx())) as { sessions: Array<{ id: string; running: boolean }> }
    expect(page.sessions.find((s) => s.id === id)!.running).toBe(true)
    clearSessionActiveStream(id, 'req-1')
    const page2 = (await list.handler({}, ctx())) as { sessions: Array<{ id: string; running: boolean }> }
    expect(page2.sessions.find((s) => s.id === id)!.running).toBe(false)
  })

  it('user-visible 视图：internal/hidden 会话不出现在能力结果中', async () => {
    await seedSession('普通会话')
    createSession(db, { name: '内部会话', ownership: 'internal', visibility: 'primary' })
    const list = findCap('action.session.list')
    const page = (await list.handler({}, ctx())) as { sessions: Array<{ name: string }>; total: number }
    expect(page.total).toBe(1)
    expect(page.sessions[0]!.name).toBe('普通会话')
  })
})

describe('action.session.status', () => {
  it('活跃请求存在 → running:true；否则 false', async () => {
    const id = await seedSession('某会话')
    const status = findCap('action.session.status')
    const idle = (await status.handler({ sessionId: id }, ctx())) as { running: boolean }
    expect(idle.running).toBe(false)
    registerSessionActiveStream(id, 'req-9')
    const running = (await status.handler({ sessionId: id }, ctx())) as { running: boolean }
    expect(running.running).toBe(true)
    clearSessionActiveStream(id, 'req-9')
  })

  it('sessionId 缺失 → invalid-params（经 zod 校验）', async () => {
    const status = findCap('action.session.status')
    const { callCapability } = await import('../callCapability')
    const { CapabilityRegistry } = await import('../registry')
    const registry = new CapabilityRegistry()
    registry.register(status)
    const result = await callCapability(registry, 'action.session.status', {}, ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-params')
  })
})

describe('action.session.read', () => {
  it('按 sequence 游标分页读取消息（复用 getMessagesPage）', async () => {
    const id = await seedSession('阅读会话', ['消息 0', '消息 1', '消息 2'])
    const read = findCap('action.session.read')
    const page1 = (await read.handler({ sessionId: id, limit: 2 }, ctx())) as {
      messages: Array<{ sequence: number; role: string; content: string }>
      nextSequence: number
      hasMore: boolean
    }
    expect(page1.messages).toHaveLength(2)
    expect(page1.messages[0]!.content).toBe('消息 0')
    expect(page1.messages[0]!.sequence).toBe(0)
    expect(page1.hasMore).toBe(true)

    const page2 = (await read.handler({ sessionId: id, cursor: page1.nextSequence, limit: 2 }, ctx())) as {
      messages: Array<{ content: string }>
      hasMore: boolean
    }
    expect(page2.messages).toHaveLength(1)
    expect(page2.messages[0]!.content).toBe('消息 2')
    expect(page2.hasMore).toBe(false)
  })

  it('单条大消息截断为摘要 + 提示', async () => {
    const id = await seedSession('大消息会话', ['x'.repeat(20_000)])
    const read = findCap('action.session.read')
    const page = (await read.handler({ sessionId: id }, ctx())) as {
      messages: Array<{ content: string; truncated?: boolean; originalChars?: number }>
    }
    expect(page.messages[0]!.truncated).toBe(true)
    expect(page.messages[0]!.content.length).toBeLessThan(20_000)
    expect(page.messages[0]!.originalChars).toBe(20_000)
  })

  it('空会话返回空页', async () => {
    const id = await seedSession('空会话')
    const read = findCap('action.session.read')
    const page = (await read.handler({ sessionId: id }, ctx())) as { messages: unknown[]; hasMore: boolean }
    expect(page.messages).toHaveLength(0)
    expect(page.hasMore).toBe(false)
  })
})

describe('与既有数据源口径一致', () => {
  it('list 总数与 listSessions(user-visible) 一致', async () => {
    await seedSession('A')
    await seedSession('B')
    const list = findCap('action.session.list')
    const page = (await list.handler({}, ctx())) as { total: number }
    expect(page.total).toBe(listSessions(db, { view: 'user-visible' }).length)
    expect(getMessagesPage(db, 'no-such-session', 0, 10).messages).toHaveLength(0)
  })
})
