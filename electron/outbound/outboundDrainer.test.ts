import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOutboundAcceptor, createOutboundDrainer, type OutboundAcceptorDeps } from './outboundAcceptor'
import type { OutboundSubmitIntent, OutboundSubmitResult } from '../../src/shared/outboundProtocol'
import { DEFAULT_WIKI_CONFIG, type Message } from '../../src/shared/domainTypes'
import {
  claimQueuedTurnAtomically,
  createSession,
  enqueueQueuedUserMessage,
  getMessages,
  getNextQueuedMessage,
  type AppDatabase
} from '../database'
import { createTempDatabase } from '../database/testHelpers'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function queuedCount(db: AppDatabase, sessionId: string): number {
  return getMessages(db, sessionId).filter((m) => m.status === 'queued').length
}

function makeDeps(
  db: AppDatabase,
  overrides: Partial<OutboundAcceptorDeps> = {}
): OutboundAcceptorDeps & { activeOps: { add(turnId: string, sessionId: string): void; remove(turnId: string): void; size(): number }; audit: ReturnType<typeof vi.fn>; startTurn: ReturnType<typeof vi.fn>; createSession: ReturnType<typeof vi.fn>; updateSessionState: ReturnType<typeof vi.fn>; appendHintMessage: ReturnType<typeof vi.fn> } {
  const session = createSession(db, { name: 'acceptor-test' })
  const active = new Map<string, string>()
  const audit = vi.fn()
  const startTurn = vi.fn(async (input: { turnIntent: { requestId: string; sessionId: string } }) => {
    const turnId = `turn-${input.turnIntent.requestId}`
    active.set(turnId, input.turnIntent.sessionId)
    return {
      turnId,
      assistantMessage: {
        id: `a-${input.turnIntent.requestId}`,
        sessionId: input.turnIntent.sessionId,
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'streaming'
      } as unknown as Message
    }
  })
  return {
    db,
    turnRuntime: {
      listActive: (sessionId?: string) =>
        [...active].map(([turnId, sid]) => ({ turnId, sessionId: sid })).filter((t) => !sessionId || t.sessionId === sessionId)
    },
    activeOps: {
      add: (turnId, sessionId) => active.set(turnId, sessionId),
      remove: (turnId) => void active.delete(turnId),
      size: () => active.size
    },
    isDev: () => true,
    apiKeyPresent: () => true,
    getMaxParallel: () => 3,
    readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }),
    listSkills: async () => [],
    getSkill: async () => null,
    wikiInit: async () => ({ ok: true as const, rootPath: 'llm-wiki', skillInstalled: true }),
    wikiStatus: async () => ({ enabled: true, rootPath: 'llm-wiki', initialized: true, pageCount: 1, rawCount: 0 }),
    wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }),
    appendHintMessage: vi.fn(async () => undefined),
    updateSessionState: vi.fn(async () => undefined),
    createSession: vi.fn(async () => createSession(db, { name: 'created' })),
    startTurn,
    newRequestId: (() => {
      let n = 0
      return () => `gen-${++n}`
    })(),
    audit,
    ...overrides
  } as OutboundAcceptorDeps & {
    activeOps: { add(turnId: string, sessionId: string): void; remove(turnId: string): void; size(): number }
    audit: ReturnType<typeof vi.fn>
    startTurn: ReturnType<typeof vi.fn>
    createSession: ReturnType<typeof vi.fn>
    updateSessionState: ReturnType<typeof vi.fn>
    appendHintMessage: ReturnType<typeof vi.fn>
  }
}

describe('createOutboundAcceptor（集成，真实 DB 排队路径）', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-acceptor-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => cleanup())

  it('运行中提交普通文本 → queued 落库（receipt + queued 消息）', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 's1' })
    deps.activeOps.add('t-live', session.id)
    const res = await acceptor.submitOutbound({ sessionId: session.id, text: '排队消息' })
    expect(res).toMatchObject({ accepted: 'queued', sessionId: session.id })
    expect(queuedCount(db, session.id)).toBe(1)
    expect(deps.audit).not.toHaveBeenCalled()
  })

  it('未运行提交普通文本 → start-turn 并把 turn 登记为 active', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 's2' })
    const res = await acceptor.submitOutbound({ sessionId: session.id, text: '发起回合' })
    expect(res).toMatchObject({ accepted: 'turn-started' })
    if (res.accepted === 'turn-started') {
      expect(deps.activeOps.size()).toBe(1)
    }
  })

  it('无 sessionId → 主进程创建会话（决定回主进程）', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const res = await acceptor.submitOutbound({ text: '新会话首条' })
    expect(res).toMatchObject({ accepted: 'turn-started' })
    expect(deps.createSession).toHaveBeenCalled()
  })

  it('拒绝结果必带错误码且不静默（审计留痕）', async () => {
    const deps = makeDeps(db, { apiKeyPresent: () => false })
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 's3' })
    const res = await acceptor.submitOutbound({ sessionId: session.id, text: '你好' })
    expect(res).toMatchObject({ rejected: { reason: 'OUTBOUND_API_KEY_MISSING' } })
    expect(deps.audit).toHaveBeenCalledWith(
      'outbound.submit.rejected',
      expect.objectContaining({ reason: 'OUTBOUND_API_KEY_MISSING' })
    )
  })

  it('hint-only：落提示消息 + skillsState 落库，返回 local-command', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 's4' })
    const res = await acceptor.submitOutbound({ sessionId: session.id, text: '/skill list' })
    expect(res).toMatchObject({ accepted: 'local-command', command: { kind: 'hint-only' } })
    expect(deps.appendHintMessage).toHaveBeenCalledWith(session.id, expect.stringContaining('可用 Skill'))
  })
})

describe('createOutboundAcceptor（随机操作序列不变量）', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-acceptor-inv-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => cleanup())

  it('反复 submit/终态/claim 后：active 轮次 ∈ [0, maxParallel]，排队条数守恒', async () => {
    const rand = mulberry32(20260919)
    const deps = makeDeps(db, { getMaxParallel: () => 2 })
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 'inv' })

    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'seed-req', content: 'seed queued' })

    for (let i = 0; i < 200; i++) {
      const roll = rand()
      if (roll < 0.55) {
        const text = roll < 0.15 ? '/skill list' : `msg-${i}`
        const res = await acceptor.submitOutbound({ sessionId: session.id, text })
        if (res.accepted === 'queued') {
          expect(queuedCount(db, session.id)).toBeLessThanOrEqual(10)
        }
        if (res.accepted === 'turn-started') {
          expect(deps.turnRuntime.listActive(session.id).length).toBeLessThanOrEqual(2)
        }
        expect('rejected' in res || res.accepted === 'turn-started' || res.accepted === 'queued' || res.accepted === 'local-command').toBe(true)
      } else if (roll < 0.8) {
        const actives = deps.turnRuntime.listActive()
        if (actives.length > 0) deps.activeOps.remove(actives[0]!.turnId)
      } else {
        const next = getNextQueuedMessage(db, session.id)
        if (next?.requestId && deps.turnRuntime.listActive(session.id).length < 2) {
          try {
            claimQueuedTurnAtomically(db, {
              sessionId: session.id,
              userMessageId: next.message.id,
              turnId: `turn-${next.requestId}`,
              assistantMessageId: `a-${next.requestId}`,
              requestId: next.requestId
            })
            deps.activeOps.add(`turn-${next.requestId}`, session.id)
          } catch {
            // SESSION_TURN_BUSY / NOT_CLAIMABLE 属合法竞争
          }
        }
      }
      const actives = deps.turnRuntime.listActive().length
      expect(actives).toBeLessThanOrEqual(2)
      expect(actives).toBeGreaterThanOrEqual(0)
      expect(queuedCount(db, session.id)).toBeLessThanOrEqual(10)
    }
  })
})

describe('createOutboundDrainer（排水不变量）', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-drain-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => cleanup())

  function makeDrainerHarness(overrides: Partial<Parameters<typeof createOutboundDrainer>[0]> = {}) {
    const session = createSession(db, { name: 'drain-test' })
    const audit = vi.fn()
    const submits: OutboundSubmitIntent[] = []
    let listActiveCountValue = 0
    const drainer = createOutboundDrainer({
      submitOutbound: vi.fn(async (intent: OutboundSubmitIntent) => {
        submits.push(intent)
        return {
          accepted: 'turn-started',
          sessionId: intent.sessionId!,
          turnId: 't1',
          assistantMessage: { id: 'a1' } as unknown as Message
        }
      }),
      listActiveCount: () => listActiveCountValue,
      getNextQueued: (sessionId: string) => getNextQueuedMessage(db, sessionId),
      audit,
      ...overrides
    })
    return { session, audit, submits, drainer, setActive: (n: number) => (listActiveCountValue = n) }
  }

  it('turn 终态 → 队首 queued 以 reuse-user + 原 requestId 发起', async () => {
    const h = makeDrainerHarness()
    const enq = enqueueQueuedUserMessage(db, { sessionId: h.session.id, requestId: 'q-req-1', content: 'next turn' })
    h.setActive(0)
    await h.drainer.drain(h.session.id)
    expect(h.submits).toHaveLength(1)
    const intent = h.submits[0]!
    expect(intent.contextIntent?.kind).toBe('reuse-user')
    if (intent.contextIntent?.kind === 'reuse-user') {
      expect(intent.contextIntent.requestId).toBe('q-req-1')
      expect(intent.contextIntent.currentUser.message.id).toBe(enq.persisted.message.id)
    }
    expect(h.audit).not.toHaveBeenCalled()
  })

  it('队空 → 不驱动；队列长度不变', async () => {
    const h = makeDrainerHarness()
    expect(queuedCount(db, h.session.id)).toBe(0)
    await h.drainer.drain(h.session.id)
    expect(h.submits).toHaveLength(0)
  })

  it('会话仍有 active turn → 不驱动（不并发双驱）', async () => {
    const h = makeDrainerHarness()
    enqueueQueuedUserMessage(db, { sessionId: h.session.id, requestId: 'q-req-2', content: 'next' })
    h.setActive(1)
    await h.drainer.drain(h.session.id)
    expect(h.submits).toHaveLength(0)
    expect(queuedCount(db, h.session.id)).toBe(1)
  })

  it('同会话排水进行中重复触发 → 合并为一次（防重入）', async () => {
    const h = makeDrainerHarness()
    enqueueQueuedUserMessage(db, { sessionId: h.session.id, requestId: 'q-req-3', content: 'next' })
    h.setActive(0)
    const p1 = h.drainer.drain(h.session.id)
    const p2 = h.drainer.drain(h.session.id)
    await Promise.all([p1, p2])
    expect(h.submits).toHaveLength(1)
  })

  it('排水被拒 → 落审计不静默', async () => {
    const session = createSession(db, { name: 'drain-reject' })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'q-req-4', content: 'next' })
    const audit = vi.fn()
    const drainer = createOutboundDrainer({
      submitOutbound: vi.fn(async () => ({ rejected: { reason: 'OUTBOUND_API_KEY_MISSING' } })),
      listActiveCount: () => 0,
      getNextQueued: (sessionId: string) => getNextQueuedMessage(db, sessionId),
      audit
    })
    await drainer.drain(session.id)
    expect(audit).toHaveBeenCalledWith(
      'outbound.drain.rejected',
      expect.objectContaining({ reason: 'OUTBOUND_API_KEY_MISSING' })
    )
  })

  it('排水后队列长度守恒：claim 成功 -1，队空后不再变化', async () => {
    const h = makeDrainerHarness()
    const e1 = enqueueQueuedUserMessage(db, { sessionId: h.session.id, requestId: 'q-1', content: 'one' })
    const before = queuedCount(db, h.session.id)
    expect(before).toBe(1)
    h.setActive(0)
    await h.drainer.drain(h.session.id)
    claimQueuedTurnAtomically(db, {
      sessionId: h.session.id,
      userMessageId: e1.persisted.message.id,
      turnId: 'turn-q-1',
      assistantMessageId: 'a-q-1',
      requestId: 'q-1'
    })
    expect(queuedCount(db, h.session.id)).toBe(before - 1)
    await h.drainer.drain(h.session.id)
    expect(h.submits.filter((s) => s.sessionId === h.session.id)).toHaveLength(1)
    expect(queuedCount(db, h.session.id)).toBe(0)
  })

  it('onTurnProjection 仅在终态事实事件时触发排水', async () => {
    const h = makeDrainerHarness()
    enqueueQueuedUserMessage(db, { sessionId: h.session.id, requestId: 'q-9', content: 'next' })
    h.setActive(0)
    const turn = { sessionId: h.session.id } as never
    h.drainer.onTurnProjection(turn, { type: 'content-delta', text: 'x' })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.submits).toHaveLength(0)
    h.drainer.onTurnProjection(turn, { type: 'source-completed' })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.submits).toHaveLength(1)
    // 队列已被上一轮排水消费（claim 后清空）：后续终态事件不再驱动（队空不变量）
    claimQueuedTurnAtomically(db, {
      sessionId: h.session.id,
      userMessageId: getNextQueuedMessage(db, h.session.id)!.message.id,
      turnId: 'turn-q-9',
      assistantMessageId: 'a-q-9',
      requestId: 'q-9'
    })
    h.drainer.onTurnProjection(turn, { type: 'source-failed' })
    h.drainer.onTurnProjection(turn, { type: 'source-cancelled' })
    h.drainer.onTurnProjection(turn, { type: 'source-timeout' })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.submits).toHaveLength(1)
  })
})
