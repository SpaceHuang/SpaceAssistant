import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOutboundAcceptor, createOutboundDrainer, type OutboundAcceptorDeps } from './outboundAcceptor'
import type { OutboundSubmitIntent, OutboundSubmitResult } from '../../src/shared/outboundProtocol'
import { DEFAULT_WIKI_CONFIG, type Message } from '../../src/shared/domainTypes'
import {
  claimQueuedTurnAtomically,
  createSession,
  deleteQueuedUserMessage,
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
  const createSessionFn = vi.fn(async (_prefs?: unknown) => createSession(db, { name: 'created' }))
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
    appendHintMessage: vi.fn(async () => ({ messageId: 'hint-1', sequence: 1 })),
    updateSessionState: vi.fn(async () => undefined),
    createSession: createSessionFn,
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

  it('B1:运行中带附件提交(contextIntent.create-user.attachments)→ 排队消息落库含附件', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 'b1' })
    deps.activeOps.add('t-live', session.id)
    const attachments = [
      { id: 'img-1', stagingKey: 'chat-attachments/x/1.png', fileName: '1.png', mimeType: 'image/png' } as never
    ]
    const res = await acceptor.submitOutbound({
      sessionId: session.id,
      text: '看这张图',
      contextIntent: { kind: 'create-user', text: '看这张图', attachments }
    })
    expect(res).toMatchObject({ accepted: 'queued' })
    const stored = getMessages(db, session.id).find((m) => m.content === '看这张图')
    expect(stored?.attachments).toHaveLength(1)
    expect((stored?.attachments as unknown[])[0]).toMatchObject({ id: 'img-1' })
  })

  it('B2:无会话提交携带 sessionPrefs → 代建会话收到 model/llmServiceId/thinkingEffort', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const res = await acceptor.submitOutbound({
      text: '新会话首条',
      sessionPrefs: { model: 'glm-5', llmServiceId: 'svc-2', thinkingEffort: 'high' }
    })
    expect(res).toMatchObject({ accepted: 'turn-started' })
    expect(deps.createSession).toHaveBeenCalledWith({ model: 'glm-5', llmServiceId: 'svc-2', thinkingEffort: 'high' })
  })

  it('B3:wiki run 发起时提示消息落库(hint 不再丢弃)', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 'b3' })
    const res = await acceptor.submitOutbound({ sessionId: session.id, text: '/wiki query 如何重构' })
    expect(res).toMatchObject({ accepted: 'turn-started' })
    expect(deps.appendHintMessage).toHaveBeenCalledWith(session.id, expect.stringContaining('已进入 Wiki Query'))
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
    const customSubmit = (overrides as { onSubmit?: (intent: OutboundSubmitIntent) => OutboundSubmitResult | undefined }).onSubmit
    const drainer = createOutboundDrainer({
      submitOutbound: vi.fn(async (intent: OutboundSubmitIntent) => {
        submits.push(intent)
        if (customSubmit) {
          const custom = customSubmit(intent)
          if (custom) return custom
        }
        // 成功发起后 active=1(模拟真实 turnRuntime 状态),防兜底误判
        listActiveCountValue = 1
        return {
          accepted: 'turn-started',
          sessionId: intent.sessionId!,
          turnId: 't1',
          assistantMessage: { id: 'a1' } as unknown as Message
        }
      }),
      listActiveCount: () => listActiveCountValue,
      getNextQueued: (sessionId: string) => getNextQueuedMessage(db, sessionId),
      consumeQueued: (_sessionId: string, messageId: string) => {
        deleteQueuedUserMessage(db, messageId)
      },
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

  it('B5:排队的本地命令被排水器消费(审计 + 删除)并继续驱动下一条', async () => {
    const h = makeDrainerHarness({
      onSubmit: (intent: OutboundSubmitIntent) => {
        // 主进程无法执行渲染端本地命令 → 受理端口分类为 local-command
        if (intent.text === '/test-cards') return { accepted: 'local-command', command: { kind: 'test-cards-run' } }
        return undefined
      }
    } as never)
    const cmdEnq = enqueueQueuedUserMessage(db, { sessionId: h.session.id, requestId: 'cmd-1', content: '/test-cards' })
    enqueueQueuedUserMessage(db, { sessionId: h.session.id, requestId: 'msg-1', content: '普通消息' })
    h.setActive(0)
    await h.drainer.drain(h.session.id)
    await new Promise((r) => setTimeout(r, 0))
    // 本地命令被消费删除 + 审计,不是静默丢弃
    expect(queuedCount(db, h.session.id)).toBe(1)
    expect(getMessages(db, h.session.id).some((m) => m.id === cmdEnq.persisted.message.id)).toBe(false)
    expect(h.audit).toHaveBeenCalledWith(
      'outbound.drain.local_command_consumed',
      expect.objectContaining({ requestId: 'cmd-1' })
    )
    // 继续驱动了后面的普通消息
    expect(h.submits.some((s) => s.contextIntent?.kind === 'reuse-user' && s.text === '普通消息')).toBe(true)
  })

  it('B6:submit 期间终态投影被挡(configuring 立即失败)→ drain 结束后补扫,队列不停摆', async () => {
    const session = createSession(db, { name: 'b6' })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'q-a', content: 'first' })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'q-b', content: 'second' })
    const audit = vi.fn()
    const submits: OutboundSubmitIntent[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const drainer = createOutboundDrainer({
      submitOutbound: vi.fn(async (intent: OutboundSubmitIntent) => {
        submits.push(intent)
        if (submits.length === 1) {
          // 第一次 submit 挂起,模拟 configuring 阶段
          await gate
        }
        // 模拟 prepare 链的 claim:队首 queued 转 sent
        if (intent.contextIntent?.kind === 'reuse-user') {
          deleteQueuedUserMessage(db, intent.contextIntent.currentUser.message.id)
        }
        return {
          accepted: 'turn-started',
          sessionId: intent.sessionId!,
          turnId: 't-' + submits.length,
          assistantMessage: { id: 'a-' + submits.length } as unknown as Message
        }
      }),
      listActiveCount: () => 0,
      getNextQueued: (sessionId: string) => getNextQueuedMessage(db, sessionId),
      consumeQueued: (_sessionId: string, messageId: string) => {
        deleteQueuedUserMessage(db, messageId)
      },
      audit
    })
    const p = drainer.drain(session.id)
    await Promise.resolve()
    await Promise.resolve()
    // drain 挂起期间,新 turn 的 configuring 立即失败 → 终态投影同步到达(被 draining 挡)
    drainer.onTurnProjection({ sessionId: session.id }, { type: 'source-failed' })
    release()
    await p
    await new Promise((r) => setTimeout(r, 0))
    // 被挡的触发被补扫:第二条排队消息得到驱动,队列不停摆
    expect(submits).toHaveLength(2)
    expect(submits[1]!.text).toBe('second')
    expect(audit).not.toHaveBeenCalledWith('outbound.drain.stalled', expect.anything())
  })

  it('B6:连续 rejected 至多重试 3 轮后停摆并落审计(不自旋)', async () => {
    const session = createSession(db, { name: 'b6b' })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'q-b', content: 'x' })
    const audit = vi.fn()
    const drainer = createOutboundDrainer({
      submitOutbound: vi.fn(async () => ({ rejected: { reason: 'OUTBOUND_API_KEY_MISSING' } })),
      listActiveCount: () => 0,
      getNextQueued: (sessionId: string) => getNextQueuedMessage(db, sessionId),
      consumeQueued: () => undefined,
      audit
    })
    await drainer.drain(session.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(audit).toHaveBeenCalledWith('outbound.drain.stalled', expect.objectContaining({ sessionId: session.id }))
    // 队列保留(非命令类不被消费),等下一条终态/用户动作再试
    expect(queuedCount(db, session.id)).toBe(1)
  })
})
