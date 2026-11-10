import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOutboundAcceptor as createSessionStorageOutboundAcceptor, createOutboundDrainer, type OutboundAcceptorDeps } from './outboundAcceptor'
import type { OutboundSubmitIntent, OutboundSubmitResult } from '../../src/shared/outboundProtocol'
import { DEFAULT_WIKI_CONFIG, type Message } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { claimQueuedTurnAtomically, claimQueuedTurnAtomicallyInScope, createSession, deleteQueuedUserMessage, enqueueQueuedUserMessage, enqueueQueuedUserMessageInScope, getMessages, getNextQueuedMessage, getNextDesktopQueueInput, listQueuedUserMessages } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { CallAdmissionGate } from '../runtime/callAdmissionGate'
import { DEFAULT_ADMISSION_POLICY } from '../runtime/callAdmission'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { isSessionContextCompactionLocked, onSessionContextCompactionRelease, withSessionContextCompactionLock } from '../sessionCompactionLock'
import { insertRuntimeTrigger } from '../triggers/store'
import { wakeQueuedAgentSessions } from './desktopAgentSessionWake'
import { classifyAgentSessionStartFailure } from './agentSessionStartFailure'

function createOutboundAcceptor(deps: OutboundAcceptorDeps) {
  const storage = createSqliteSessionStorage(deps.db)
  return createSessionStorageOutboundAcceptor({
    ...deps,
    sessionQueries: deps.sessionQueries ?? storage.queries,
    sessionCommands: deps.sessionCommands ?? storage.commands,
    sessionExecution: deps.sessionExecution ?? storage.execution
  })
}

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
    sessionQueries: createSqliteSessionStorage(db).queries,
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
    listSkills: async () => [],
    getSkill: async () => null,
    wikiInit: async () => ({ ok: true as const, rootPath: 'llm-wiki', skillInstalled: true }),
    wikiStatus: async () => ({ rootPath: 'llm-wiki', initialized: true, pageCount: 1, rawCount: 0 }),
    wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }),
    appendHintMessage: vi.fn(async () => ({ messageId: 'hint-1', sequence: 1 })),
    updateSessionState: vi.fn(async () => undefined),
    createSession: createSessionFn,
    ensureSessionWorkDir: vi.fn(async () => ({ ok: true as const })),
    notifyEnqueued: vi.fn(),
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
    ensureSessionWorkDir: ReturnType<typeof vi.fn>
    notifyEnqueued: ReturnType<typeof vi.fn>
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

  it('B1:无会话发命令 → local-command 载荷携带主进程代建的 sessionId', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const res = await acceptor.submitOutbound({ text: '/skill list' })
    expect(res).toMatchObject({ accepted: 'local-command' })
    if (res.accepted === 'local-command') {
      expect(res.sessionId).toBeTruthy()
    }
  })

  it('B2:workDir 对齐失败 → 拒绝且不发起 turn', async () => {
    const deps = makeDeps(db, { ensureSessionWorkDir: vi.fn(async () => ({ ok: false as const, error: '目录已失效' })) })
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 'b2' })
    const res = await acceptor.submitOutbound({ sessionId: session.id, text: '你好' })
    expect(res).toMatchObject({ rejected: { reason: 'OUTBOUND_WORKDIR_SWITCH_FAILED' } })
    expect(deps.startTurn).not.toHaveBeenCalled()
    expect(deps.audit).toHaveBeenCalledWith('outbound.submit.rejected', expect.objectContaining({ reason: 'OUTBOUND_WORKDIR_SWITCH_FAILED' }))
  })

  it('B2:workDir 对齐成功 → 正常发起(start-turn 前执行对齐)', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 'b2b' })
    await acceptor.submitOutbound({ sessionId: session.id, text: '你好' })
    expect(deps.ensureSessionWorkDir).toHaveBeenCalledWith(session.id)
    expect(deps.startTurn).toHaveBeenCalled()
  })

  it('B3:enqueue 落库后触发 notifyEnqueued(闭环 snapshot→enqueue 窗口的丢触发)', async () => {
    const deps = makeDeps(db)
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 'b3' })
    deps.activeOps.add('t-live', session.id)
    await acceptor.submitOutbound({ sessionId: session.id, text: '排队消息' })
    expect(deps.notifyEnqueued).toHaveBeenCalledWith(session.id)
  })

  it('B4:start-turn 撞 SESSION_TURN_BUSY → 降级排队(消息不丢)', async () => {
    const deps = makeDeps(db)
    deps.startTurn.mockRejectedValueOnce(new Error('SESSION_TURN_BUSY'))
    const acceptor = createOutboundAcceptor(deps)
    const session = createSession(db, { name: 'b4' })
    const res = await acceptor.submitOutbound({ sessionId: session.id, text: '双击快发' })
    expect(res).toMatchObject({ accepted: 'queued', sessionId: session.id })
    expect(queuedCount(db, session.id)).toBe(1)
    expect(deps.audit).toHaveBeenCalledWith('outbound.submit.degraded_to_queue', expect.objectContaining({ sessionId: session.id }))
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

  it('agent-session 队首不进入普通 outbound 执行器', async () => {
    const session = createSession(db, { name: 'agent-session-drain' })
    const owner = createSession(db, { name: 'agent-session-owner' })
    const storage = createSqliteSessionStorage(db)
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'agent-queued', content: 'untrusted input', authorizationBinding: {} })
    const submitOutbound = vi.fn(async () => ({ accepted: 'turn-started' as const, sessionId: session.id,
      turnId: 'unexpected', assistantMessage: { id: 'assistant' } as unknown as Message }))
    const drainer = createOutboundDrainer({ submitOutbound, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), audit: vi.fn() })
    await drainer.drain(session.id)
    expect(submitOutbound).not.toHaveBeenCalled()
    expect(getNextDesktopQueueInput(db, session.id)?.requestId).toBe('agent-queued')
  })

  it('agent-session 队首经专用宿主 dispatch 且 stale approval 不忙等重试', async () => {
    const session = createSession(db, { name: 'agent-session-specialized-drain' })
    const owner = createSession(db, { name: 'agent-session-specialized-owner' })
    const storage = createSqliteSessionStorage(db)
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'agent-specialized-queued', content: 'trusted input', authorizationBinding: {} })
    const submitOutbound = vi.fn()
    const startAgentSession = vi.fn(async () => 'waiting' as const)
    const drainer = createOutboundDrainer({ submitOutbound, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), startAgentSession, audit: vi.fn() })

    await drainer.drain(session.id)
    await Promise.resolve()

    expect(startAgentSession).toHaveBeenCalledWith({ sessionId: session.id, requestId: accepted.receipt.requestId,
      messageId: accepted.source.messageId })
    expect(submitOutbound).not.toHaveBeenCalled()
    expect(getNextDesktopQueueInput(db, session.id)?.requestId).toBe('agent-specialized-queued')
  })

  it('current execution policy denial settles the agent-session head and continues FIFO without ordinary-dispatching it', async () => {
    const session = createSession(db, { name: 'agent-policy-denied-target' })
    const owner = createSession(db, { name: 'agent-policy-denied-owner' })
    const storage = createSqliteSessionStorage(db)
    const denied = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'agent-policy-denied', content: 'denied by current execution policy', authorizationBinding: {} })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'after-policy-denial', content: 'next ordinary input' })
    const submitOutbound = vi.fn(async (intent: OutboundSubmitIntent) => ({ accepted: 'turn-started' as const,
      sessionId: intent.sessionId!, turnId: 'after-denial-turn', assistantMessage: { id: 'assistant-after-denial' } as unknown as Message }))
    const startAgentSession = vi.fn(async () => {
      storage.commands.agentSessionMessages.markNotExecuted({ sessionId: session.id,
        requestId: denied.receipt.requestId, reason: 'policy-rejected' })
      return 'rejected' as const
    })
    const drainer = createOutboundDrainer({ submitOutbound, startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined, audit: vi.fn() })
    await drainer.drain(session.id)
    expect(startAgentSession).toHaveBeenCalledTimes(1)
    expect(submitOutbound).toHaveBeenCalledTimes(1)
    expect(submitOutbound.mock.calls[0]?.[0].contextIntent).toMatchObject({ kind: 'reuse-user', requestId: 'after-policy-denial' })
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId: denied.receipt.requestId }))
      .toMatchObject({ kind: 'not-executed', reason: 'policy-rejected' })
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

  it('B6(v2):随机终态/触发/入队交错序列的不变量——无 active 且队非空必有 submit 或 stalled;条目守恒', async () => {
    const session = createSession(db, { name: 'b6-inv' })
    const audit = vi.fn()
    const submits: OutboundSubmitIntent[] = []
    const active = new Set<string>()
    let seq = 0
    const drainer = createOutboundDrainer({
      submitOutbound: vi.fn(async (intent: OutboundSubmitIntent) => {
        submits.push(intent)
        if (intent.text.startsWith('/cmd')) {
          // 本地命令:受理端口分类为 local-command,由排水器消费
          return { accepted: 'local-command', command: { kind: 'test-cards-run' } }
        }
        // 模拟 prepare 链 claim:队首 queued 转 sent 并登记 active
        if (intent.contextIntent?.kind === 'reuse-user') {
          deleteQueuedUserMessage(db, intent.contextIntent.currentUser.message.id)
          const turnId = `t-${++seq}`
          active.add(turnId)
        }
        return {
          accepted: 'turn-started',
          sessionId: intent.sessionId!,
          turnId: `t-${seq}`,
          assistantMessage: { id: `a-${seq}` } as unknown as Message
        }
      }),
      listActiveCount: () => active.size,
      getNextQueued: (sessionId: string) => getNextQueuedMessage(db, sessionId),
      consumeQueued: (_sessionId: string, messageId: string) => {
        deleteQueuedUserMessage(db, messageId)
      },
      audit
    })

    const rand = mulberry32(20260920)
    const settle = () => new Promise((r) => setTimeout(r, 0))
    let enqueuedTotal = 0

    for (let step = 0; step < 120; step++) {
      const roll = rand()
      if (roll < 0.35) {
        const isCmd = roll < 0.1
        enqueueQueuedUserMessage(db, {
          sessionId: session.id,
          requestId: `rq-${step}`,
          content: isCmd ? `/cmd-${step}` : `msg-${step}`
        })
        enqueuedTotal += 1
        await drainer.drain(session.id, 'queue-enqueued')
      } else if (roll < 0.6) {
        // 随机终态:清掉一个 active turn 并发终态投影(触发排水)
        const turnId = [...active][0]
        if (turnId) {
          active.delete(turnId)
          drainer.onTurnProjection({ sessionId: session.id }, { type: 'source-completed' })
        }
      } else if (roll < 0.75) {
        // 重复终态投影(被挡/无 active 的空触发)
        drainer.onTurnProjection({ sessionId: session.id }, { type: 'source-completed' })
      } else if (roll < 0.9) {
        await drainer.drain(session.id, roll < 0.83 ? 'capacity-released' : 'startup-recovery')
      } else {
        await settle()
      }
      // 步进不变量:排队条数只可能来自 enqueue(不凭空增);active 非负
      expect(queuedCount(db, session.id)).toBeLessThanOrEqual(enqueuedTotal)
      expect(active.size).toBeGreaterThanOrEqual(0)
      expect(active.size).toBeLessThanOrEqual(1)
    }

    // 排空所有未 settled 的重排链
    for (let i = 0; i < 10; i++) await settle()

    // 终局不变量 I2:不存在「无 active 且队非空且无 submit/stalled」的终态(丢触发 ⇒ 停摆)
    const stalledAudited = audit.mock.calls.some((c) => c[0] === 'outbound.drain.stalled')
    if (active.size === 0 && queuedCount(db, session.id) > 0) {
      expect(stalledAudited || submits.length > 0).toBe(true)
    }
    // 终局不变量 I3(守恒):消息只会被 claim 转 sent 或被消费删除,不凭空消失
    const all = getMessages(db, session.id)
    for (const m of all) {
      expect(['sent', 'queued']).toContain(m.status)
    }
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

  it('agent-session 启动错误耗尽后写 not-executed 并推进下一条队首', async () => {
    const session = createSession(db, { name: 'agent-start-failure' })
    const owner = createSession(db, { name: 'agent-start-owner' })
    const storage = createSqliteSessionStorage(db)
    const failed = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'agent-fails', content: 'will not execute', authorizationBinding: {} })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'after-agent', content: 'next' })
    const startAgentSession = vi.fn(async () => { throw new Error('configuration failed') })
    const submitOutbound = vi.fn(async (intent: OutboundSubmitIntent) => ({ accepted: 'turn-started' as const,
      sessionId: intent.sessionId!, turnId: 'next-turn', assistantMessage: { id: 'assistant' } as unknown as Message }))
    const drainer = createOutboundDrainer({ submitOutbound, startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined,
      settleAgentSessionStartFailure: ({ sessionId, requestId }) => storage.commands.agentSessionMessages.markNotExecuted({ sessionId, requestId, reason: 'start-failed' }),
      audit: vi.fn() })
    await drainer.drain(session.id)
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(startAgentSession).toHaveBeenCalledTimes(4)
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId: failed.receipt.requestId }))
      .toMatchObject({ kind: 'not-executed', reason: 'start-failed' })
    expect(submitOutbound).toHaveBeenCalledTimes(1)
    expect(submitOutbound.mock.calls[0]?.[0].contextIntent).toMatchObject({ kind: 'reuse-user', requestId: 'after-agent' })
    expect(getNextDesktopQueueInput(db, session.id)?.requestId).toBe('after-agent')
  })

  it('撤回旧队首后把启动失败预算归属旧请求，允许新队首完成第四次启动', async () => {
    const session = createSession(db, { name: 'retry-budget-head-change' })
    const owner = createSession(db, { name: 'retry-budget-head-change-owner' })
    const storage = createSqliteSessionStorage(db)
    const old = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'retry-old-head', content: 'old head', authorizationBinding: {} })
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'retry-new-head', content: 'new head', authorizationBinding: {} })
    let releaseOldStart!: () => void
    const oldStartGate = new Promise<void>((resolve) => { releaseOldStart = resolve })
    let newHeadAttempts = 0
    const startAgentSession = vi.fn(async ({ requestId }: { requestId: string }) => {
      if (requestId === old.receipt.requestId) {
        await oldStartGate
        throw new Error('old request startup failed after revoke')
      }
      newHeadAttempts += 1
      if (newHeadAttempts < 4) throw new Error(`new request startup failure ${newHeadAttempts}`)
      return 'started' as const
    })
    const drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined,
      settleAgentSessionStartFailure: ({ sessionId, requestId }) => storage.commands.agentSessionMessages.markNotExecuted({ sessionId, requestId, reason: 'start-failed' }),
      audit: vi.fn() })

    const firstDrain = drainer.drain(session.id)
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledOnce())
    expect(storage.commands.agentSessionMessages.revoke({ ownerSessionId: owner.id, requestId: old.receipt.requestId }).kind).toBe('revoked')
    releaseOldStart()
    await firstDrain
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))

    expect(startAgentSession.mock.calls.filter(([input]) => input.requestId === 'retry-new-head')).toHaveLength(4)
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId: 'retry-new-head' }))
      .toMatchObject({ kind: 'queued' })
  })

  it('在压缩锁持有期间忽略自触发的票据释放唤醒，解锁后只重新尝试一次', async () => {
    const session = createSession(db, { name: 'compaction-wake-loop' })
    const owner = createSession(db, { name: 'compaction-wake-loop-owner' })
    const storage = createSqliteSessionStorage(db)
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'compaction-wake-head', content: 'wait for compaction lock', authorizationBinding: {} })
    let releaseCompaction!: () => void
    let announceCompaction!: () => void
    const compactionStarted = new Promise<void>((resolve) => { announceCompaction = resolve })
    const compactionGate = new Promise<void>((resolve) => { releaseCompaction = resolve })
    const compaction = withSessionContextCompactionLock(session.id, async () => {
      announceCompaction()
      await compactionGate
    })
    await compactionStarted
    let drainer!: ReturnType<typeof createOutboundDrainer>
    let ticketReleaseCount = 0
    const startAgentSession = vi.fn(async () => {
      if (isSessionContextCompactionLocked(session.id)) {
        ticketReleaseCount += 1
        if (ticketReleaseCount <= 7) void drainer.drain(session.id, 'capacity-released')
        return 'compaction-busy' as const
      }
      return 'started' as const
    })
    drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined, audit: vi.fn(),
      onCompactionRelease: (sessionId, callback) => onSessionContextCompactionRelease(sessionId, callback) })

    await drainer.drain(session.id)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(startAgentSession).toHaveBeenCalledTimes(1)
    expect(ticketReleaseCount).toBe(1)

    releaseCompaction()
    await compaction
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledTimes(2))
  })

  it('准入持久化暂时失败后有界重试，存储恢复时无需其他会话事件即可启动原来信', async () => {
    const session = createSession(db, { name: 'admission-persistence-retry' })
    const owner = createSession(db, { name: 'admission-persistence-owner' })
    const storage = createSqliteSessionStorage(db)
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'admission-persistence-head', content: 'retry admission', authorizationBinding: {} })
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_admission_state_once
      BEFORE INSERT ON configs
      WHEN NEW.key = 'admission.state'
      BEGIN SELECT RAISE(ABORT, 'injected admission persistence failure'); END`)
    const admissionGate = new CallAdmissionGate({ db, policy: structuredClone(DEFAULT_ADMISSION_POLICY) })
    const audit = vi.fn()
    const startAgentSession = vi.fn(async () => {
      const admission = await admissionGate.acquire({ lane: 'desktop', priority: 'interactive', role: 'top-level',
        disposition: 'defer', requestId: 'admission-persistence-head' })
      if (!admission.ok) return admission.verdict === 'rejected' && admission.cause === 'persistence-failed'
        ? 'persistence-failed' as const : 'busy' as const
      admission.ticket.release()
      return 'started' as const
    })
    const drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined,
      settleAgentSessionStartFailure: ({ sessionId, requestId }) => storage.commands.agentSessionMessages.markNotExecuted({ sessionId, requestId, reason: 'start-failed' }),
      audit })

    await drainer.drain(session.id)
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledTimes(1), { timeout: 1_000 })
    conn.exec('DROP TRIGGER fail_admission_state_once')
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledTimes(2), { timeout: 1_000 })

    expect(getNextDesktopQueueInput(db, session.id)?.requestId).toBe('admission-persistence-head')
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId: 'admission-persistence-head' }))
      .toMatchObject({ kind: 'queued' })
    expect(audit).not.toHaveBeenCalledWith('outbound.drain.stalled', expect.anything())
  })

  it('终态落库暂时失败时不产生未处理拒绝，恢复后只结算同一来信一次再推进下一条', async () => {
    const session = createSession(db, { name: 'settlement-persistence-retry' })
    const owner = createSession(db, { name: 'settlement-persistence-owner' })
    const storage = createSqliteSessionStorage(db)
    const first = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'settlement-persistence-head', content: 'must settle', authorizationBinding: {} })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'settlement-persistence-next', content: 'next' })
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_agent_message_terminal_once
      BEFORE UPDATE OF state ON queue_input_requests
      WHEN NEW.request_id = 'settlement-persistence-head' AND NEW.state = 'not-executed:start-failed'
      BEGIN SELECT RAISE(ABORT, 'injected terminal write failure'); END`)
    const startAgentSession = vi.fn(async () => { throw new Error('configuration failed') })
    const settle = vi.fn(({ sessionId, requestId }: { sessionId: string; requestId: string }) =>
      storage.commands.agentSessionMessages.markNotExecuted({ sessionId, requestId, reason: 'start-failed' }))
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    const drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined,
      settleAgentSessionStartFailure: settle, audit: vi.fn() })

    try {
      await drainer.drain(session.id)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
      expect(getNextDesktopQueueInput(db, session.id)?.requestId).toBe('settlement-persistence-head')
      conn.exec('DROP TRIGGER fail_agent_message_terminal_once')
      await vi.waitFor(() => expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId: 'settlement-persistence-head' }))
        .toMatchObject({ kind: 'not-executed', reason: 'start-failed' }))
      await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledTimes(4))
      expect(settle).toHaveBeenCalledTimes(2)
      expect(getNextDesktopQueueInput(db, session.id)?.requestId).toBe('settlement-persistence-next')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('持续准入持久化失败时重复唤醒共享单条有界重试链', async () => {
    vi.useFakeTimers()
    const session = createSession(db, { name: 'admission-retry-bounded' })
    const owner = createSession(db, { name: 'admission-retry-bounded-owner' })
    const storage = createSqliteSessionStorage(db)
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'admission-retry-bounded-head', content: 'persistent failure', authorizationBinding: {} })
    const startAgentSession = vi.fn(async () => 'persistence-failed' as const)
    const drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined, audit: vi.fn() })

    try {
      await drainer.drain(session.id)
      await drainer.drain(session.id)
      await drainer.drain(session.id)
      await drainer.drain(session.id)
      expect(vi.getTimerCount()).toBe(1)
      for (let attempt = 0; attempt < 10; attempt += 1) await vi.advanceTimersToNextTimerAsync()
      expect(vi.getTimerCount()).toBe(0)
      expect(startAgentSession.mock.calls.length).toBeLessThanOrEqual(12)
      expect(getNextDesktopQueueInput(db, session.id)?.requestId).toBe('admission-retry-bounded-head')
    } finally {
      vi.useRealTimers()
    }
  })

  it('终态待结算期间重复唤醒不重跑已耗尽的启动预算', async () => {
    vi.useFakeTimers()
    const session = createSession(db, { name: 'settlement-wakeup-merge' })
    const owner = createSession(db, { name: 'settlement-wakeup-merge-owner' })
    const storage = createSqliteSessionStorage(db)
    const head = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'settlement-wakeup-head', content: 'retry start then settle', authorizationBinding: {} })
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'settlement-wakeup-next', content: 'next after recovery', authorizationBinding: {} })
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_settlement_until_recovered
      BEFORE UPDATE OF state ON queue_input_requests
      WHEN NEW.request_id = 'settlement-wakeup-head' AND NEW.state = 'not-executed:start-failed'
      BEGIN SELECT RAISE(ABORT, 'injected terminal persistence failure'); END`)
    const startAgentSession = vi.fn(async ({ requestId }: { requestId: string }) => {
      if (requestId === head.receipt.requestId) throw new Error('start failed')
      return 'started' as const
    })
    const settle = vi.fn(({ sessionId, requestId }: { sessionId: string; requestId: string }) =>
      storage.commands.agentSessionMessages.markNotExecuted({ sessionId, requestId, reason: 'start-failed' }))
    const drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined,
      settleAgentSessionStartFailure: settle, audit: vi.fn() })

    try {
      await drainer.drain(session.id)
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
      expect(startAgentSession.mock.calls.filter(([input]) => input.requestId === head.receipt.requestId)).toHaveLength(4)
      expect(settle).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      for (let attempt = 0; attempt < 8; attempt += 1) await vi.advanceTimersToNextTimerAsync()
      expect(settle).toHaveBeenCalledTimes(9)
      expect(vi.getTimerCount()).toBe(0)
      await drainer.drain(session.id)
      await drainer.drain(session.id)
      expect(startAgentSession.mock.calls.filter(([input]) => input.requestId === head.receipt.requestId)).toHaveLength(4)
      expect(settle).toHaveBeenCalledTimes(9)
      expect(vi.getTimerCount()).toBe(1)
      conn.exec('DROP TRIGGER fail_settlement_until_recovered')
      await vi.advanceTimersToNextTimerAsync()
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
      expect(settle).toHaveBeenCalledTimes(10)
      expect(startAgentSession.mock.calls.filter(([input]) => input.requestId === head.receipt.requestId)).toHaveLength(4)
      expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId: head.receipt.requestId }))
        .toMatchObject({ kind: 'not-executed', reason: 'start-failed' })
      expect(startAgentSession).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'settlement-wakeup-next' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('终态重试写入执行中收到唤醒不会创建第二条重试链', async () => {
    vi.useFakeTimers()
    const session = createSession(db, { name: 'settlement-work-inflight' })
    const owner = createSession(db, { name: 'settlement-work-inflight-owner' })
    const storage = createSqliteSessionStorage(db)
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'settlement-work-inflight-head', content: 'write once per retry event', authorizationBinding: {} })
    const startAgentSession = vi.fn(async () => { throw new Error('start failed') })
    let drainer!: ReturnType<typeof createOutboundDrainer>
    const settle = vi.fn(() => {
      if (settle.mock.calls.length > 1) void drainer.drain(session.id, 'capacity-released')
      return false
    })
    drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined,
      settleAgentSessionStartFailure: settle, audit: vi.fn() })

    try {
      await drainer.drain(session.id)
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
      expect(startAgentSession).toHaveBeenCalledTimes(4)
      expect(settle).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)

      vi.advanceTimersByTime(25)
      expect(settle).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(25)
      expect(settle).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(25)
      expect(settle).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('更早的真实 runtime-trigger 队首等待清除时不消耗已批准来信启动预算', async () => {
    const target = createSession(db, { name: 'trigger-before-agent-target' })
    const owner = createSession(db, { name: 'trigger-before-agent-owner' })
    const storage = createSqliteSessionStorage(db)
    const triggerId = 'trigger-before-agent'
    const queueScope = { kind: 'desktop' } as const
    const triggerRequestId = `runtime-trigger:${triggerId}`
    const authorization = { bindingVersion: 1, requestId: triggerRequestId, ownerSessionId: owner.id,
      receiverSessionId: target.id, queueScope, sourceIdentity: { kind: 'test-source' }, payloadDigest: 'trigger-payload',
      policyRevision: 'policy-1', authorizationGeneration: 'auth-1', runtimeGeneration: 'runtime-1' }
    insertRuntimeTrigger(storage.commands, { id: triggerId, ownerSessionId: owner.id, receiverSessionId: target.id,
      clientKey: 'trigger-before-agent-key', definition: { version: 1, condition: { type: 'turn_completed', targetSessionId: owner.id,
        turnId: 'source-turn' }, sourceBaseline: {} }, state: 'matched', result: { authorization }, createdAt: 1,
      expiresAt: Date.now() + 60_000, attempts: 0, revision: 1, updatedAt: 1 })
    const notification = enqueueQueuedUserMessageInScope(db, { sessionId: target.id, requestId: triggerRequestId,
      content: `运行时事件待处理：${triggerId}`, queueScope })
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId: 'approved-behind-trigger', content: 'approved content', authorizationBinding: {} })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id,
      requestId: accepted.receipt.requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'decision:approved-behind-trigger',
      permitRef: 'permit:approved-behind-trigger', ownerSessionId: owner.id, targetSessionId: target.id,
      targetGeneration: target.generation, workDirProfileId: target.workDirProfileId || 'default',
      requestId: accepted.receipt.requestId, messageId: snapshot.source.messageId, queueScope: 'desktop' as const,
      payloadDigest: snapshot.source.payloadSha256, policyRevision: 'policy-1', authorizationGeneration: 'auth-1',
      runtimeGeneration: 'runtime-1', approvedAt: Date.now() }
    expect(storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id,
      requestId: accepted.receipt.requestId, expectedOriginDigest: snapshot.originDigest,
      expectedApprovalDigest: snapshot.approvalDigest ?? null, approval })).not.toBeNull()
    expect(getNextDesktopQueueInput(db, target.id)?.requestId).toBe(notification.receipt.requestId)
    expect(getNextDesktopQueueInput(db, target.id)?.source).toBe('runtime-trigger')
    const physicalHeadStart = vi.fn(async () => 'started' as const)
    const physicalHeadDrainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession: physicalHeadStart,
      listActiveCount: () => 0, getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId),
      consumeQueued: () => undefined, audit: vi.fn() })
    await physicalHeadDrainer.drain(target.id)
    expect(physicalHeadStart).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare('SELECT state FROM queue_input_requests WHERE session_id=? AND request_id=?')
      .get(target.id, accepted.receipt.requestId)).toEqual({ state: 'queued' })

    let triggerTurnActive = false
    let agentTurnActive = false
    let drainer!: ReturnType<typeof createOutboundDrainer>
    let ticketReleaseCount = 0
    let releaseWakeCount = 0
    const filteredAgentQueue = (sessionId: string) => {
      const candidate = listQueuedUserMessages(db, { sessionId, queueScope, source: 'agent-session' })[0]
      return candidate ? { ...candidate, source: 'agent-session' as const } : null
    }
    const wakeAgentQueue = (reason: 'capacity-released' | 'turn-terminal' = 'capacity-released') => wakeQueuedAgentSessions({ sessionIds: () => [target.id],
      getNextQueued: filteredAgentQueue, recoverTarget: () => ({ status: 'ready' }),
      reason, drain: (sessionId, wakeReason) => drainer.drain(sessionId, wakeReason) })
    const admissionGate = new CallAdmissionGate({ db, onReleased: () => {
      releaseWakeCount += 1
      if (releaseWakeCount <= 8) wakeAgentQueue('capacity-released')
    } })
    const startAgentSession = vi.fn(async ({ sessionId, requestId, messageId }: { sessionId: string; requestId: string; messageId: string }) => {
      const admission = await admissionGate.acquire({ lane: 'desktop', priority: 'interactive', role: 'top-level',
        disposition: 'defer', requestId })
      if (!admission.ok) return 'busy' as const
      let dispatchError: unknown
      let dispatchStarted = false
      try {
        claimQueuedTurnAtomicallyInScope(db, { sessionId, userMessageId: messageId, turnId: `turn:${requestId}`,
          assistantMessageId: `assistant:${requestId}`, requestId, queueScope, source: 'agent-session',
          agentSessionFinalCheck: () => true })
        agentTurnActive = true
      } catch (error) {
        dispatchError = error
      } finally {
        ticketReleaseCount += 1
        admission.ticket.release()
      }
      if (dispatchError) {
        const failure = classifyAgentSessionStartFailure(sessionId, dispatchError)
        if (failure) return failure
        throw dispatchError
      }
      dispatchStarted = true
      return dispatchStarted ? 'started' as const : 'waiting' as const
    })
    drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession,
      listActiveCount: () => Number(triggerTurnActive || agentTurnActive),
      getNextQueued: filteredAgentQueue, consumeQueued: () => undefined, audit: vi.fn(),
      settleAgentSessionStartFailure: ({ sessionId, requestId }) => storage.commands.agentSessionMessages.markNotExecuted({ sessionId, requestId, reason: 'start-failed' }) })

    await drainer.drain(target.id)
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
    expect(startAgentSession).toHaveBeenCalledTimes(1)
    expect(ticketReleaseCount).toBe(1)
    expect(releaseWakeCount).toBe(1)
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId: accepted.receipt.requestId }))
      .toMatchObject({ kind: 'queued' })
    expect(getDbConnection(db).prepare('SELECT state FROM queue_input_requests WHERE session_id=? AND request_id=?')
      .get(target.id, accepted.receipt.requestId)).toEqual({ state: 'queued' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM turns WHERE request_id=?')
      .get(accepted.receipt.requestId)).toEqual({ count: 0 })

    claimQueuedTurnAtomicallyInScope(db, { sessionId: target.id, userMessageId: notification.persisted.message.id,
      turnId: 'trigger-notification-turn', assistantMessageId: 'trigger-notification-assistant', requestId: triggerRequestId,
      queueScope, source: 'runtime-trigger' })
    triggerTurnActive = true
    expect(storage.commands.runtimeTriggers.read(triggerId)?.state).toBe('matched')
    getDbConnection(db).prepare("UPDATE turns SET state='terminal',outcome='completed',updated_at=? WHERE turn_id='trigger-notification-turn'")
      .run(Date.now())
    triggerTurnActive = false
    expect(getNextDesktopQueueInput(db, target.id)?.requestId).toBe(accepted.receipt.requestId)
    wakeAgentQueue('turn-terminal')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(startAgentSession).toHaveBeenCalledTimes(2)
    expect(ticketReleaseCount).toBe(2)
    expect(await Promise.all(startAgentSession.mock.results.map((result) => result.value))).toEqual(['queue-head-waiting', 'started'])
    expect(startAgentSession.mock.calls.map(([input]) => input.requestId)).toEqual([
      accepted.receipt.requestId, accepted.receipt.requestId
    ])
    expect(getDbConnection(db).prepare('SELECT state FROM queue_input_requests WHERE session_id=? AND request_id=?')
      .get(target.id, accepted.receipt.requestId)).toEqual({ state: 'claimed' })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(accepted.source.messageId))
      .toEqual({ status: 'sent' })
  })

  it('未知来源的物理队首不会被跳过并派发后续来信', async () => {
    const target = createSession(db, { name: 'invalid-physical-head-target' })
    const owner = createSession(db, { name: 'invalid-physical-head-owner' })
    const storage = createSqliteSessionStorage(db)
    const invalidHead = enqueueQueuedUserMessage(db, { sessionId: target.id, requestId: 'invalid-head', content: 'ordinary' })
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId: 'valid-later-agent-input', content: 'later', authorizationBinding: {} })
    getDbConnection(db).prepare('UPDATE messages SET content=? WHERE id=?')
      .run('跨会话来信：来源会话 forged，以下内容不代表用户批准。\n{}', invalidHead.persisted.message.id)

    const selected = getNextDesktopQueueInput(db, target.id)
    expect(selected).toMatchObject({ requestId: 'invalid-head', source: 'invalid' })

    const submitOutbound = vi.fn()
    const startAgentSession = vi.fn()
    const drainer = createOutboundDrainer({ submitOutbound, startAgentSession,
      listActiveCount: () => 0, getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId),
      consumeQueued: () => undefined, audit: vi.fn() })
    await drainer.drain(target.id)

    expect(submitOutbound).not.toHaveBeenCalled()
    expect(startAgentSession).not.toHaveBeenCalled()
    expect(getNextDesktopQueueInput(db, target.id)?.requestId).toBe('invalid-head')
  })

  it('队首等待期间到达的终态唤醒在队首变化后仍会被处理', async () => {
    const session = createSession(db, { name: 'queue-head-wait-keeps-terminal-wake' })
    const owner = createSession(db, { name: 'queue-head-wait-keeps-terminal-wake-owner' })
    const storage = createSqliteSessionStorage(db)
    const earlierQueueInput = enqueueQueuedUserMessage(db, { sessionId: session.id,
      requestId: 'earlier-queue-head', content: 'earlier queued input' })
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'wake-preserved-head', content: 'wait then retry', authorizationBinding: {} })
    let finishFirst!: (result: 'queue-head-waiting') => void
    const firstAttempt = new Promise<'queue-head-waiting'>((resolve) => { finishFirst = resolve })
    const startAgentSession = vi.fn().mockImplementationOnce(() => firstAttempt).mockResolvedValue('started')
    const getAgentCandidate = (sessionId: string) => {
      const candidate = listQueuedUserMessages(db, { sessionId, queueScope: { kind: 'desktop' }, source: 'agent-session' })[0]
      return candidate ? { ...candidate, source: 'agent-session' as const } : null
    }
    const drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: getAgentCandidate, consumeQueued: () => undefined, audit: vi.fn() })

    const pendingDrain = drainer.drain(session.id)
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledOnce())
    // The earlier FIFO owner completes after the atomic claim observed it and before dispatch returns.
    deleteQueuedUserMessage(db, earlierQueueInput.persisted.message.id)
    drainer.onTurnProjection({ sessionId: session.id }, { type: 'source-completed' })
    finishFirst('queue-head-waiting')
    await pendingDrain
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledTimes(2))

    expect(await Promise.all(startAgentSession.mock.results.map((result) => result.value)))
      .toEqual(['queue-head-waiting', 'started'])
  })

  it('停泊返回时消费排水期间收到的撤回唤醒并驱动新队首', async () => {
    const session = createSession(db, { name: 'parked-wakeup-revoke' })
    const owner = createSession(db, { name: 'parked-wakeup-owner' })
    const storage = createSqliteSessionStorage(db)
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'parked-first', content: 'revoke while dispatch is pending', authorizationBinding: {} })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'parked-next', content: 'next FIFO input' })
    let finishFirst!: (result: 'waiting') => void
    const firstDispatch = new Promise<'waiting'>((resolve) => { finishFirst = resolve })
    const startAgentSession = vi.fn().mockImplementationOnce(() => firstDispatch)
    const submitOutbound = vi.fn(async (intent: OutboundSubmitIntent) => ({ accepted: 'turn-started' as const,
      sessionId: intent.sessionId!, turnId: 'after-revoke-turn', assistantMessage: { id: 'assistant' } as unknown as Message }))
    const drainer = createOutboundDrainer({ submitOutbound, startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined, audit: vi.fn() })

    const firstDrain = drainer.drain(session.id)
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledOnce())
    expect(storage.commands.agentSessionMessages.revoke({ ownerSessionId: owner.id, requestId: accepted.receipt.requestId }).kind).toBe('revoked')
    await drainer.drain(session.id)
    finishFirst('waiting')
    await firstDrain
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(submitOutbound).toHaveBeenCalledOnce()
    expect(submitOutbound.mock.calls[0]?.[0].contextIntent).toMatchObject({ kind: 'reuse-user', requestId: 'parked-next' })
  })

  it('停泊返回时消费容量释放唤醒且不消耗启动失败预算', async () => {
    const session = createSession(db, { name: 'parked-wakeup-capacity' })
    const owner = createSession(db, { name: 'parked-wakeup-capacity-owner' })
    const storage = createSqliteSessionStorage(db)
    storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: session.id,
      requestId: 'capacity-wakeup-head', content: 'waiting for admission', authorizationBinding: {} })
    let finishFirst!: (result: 'busy') => void
    const firstDispatch = new Promise<'busy'>((resolve) => { finishFirst = resolve })
    const startAgentSession = vi.fn().mockImplementationOnce(() => firstDispatch).mockResolvedValue('started')
    const audit = vi.fn()
    const drainer = createOutboundDrainer({ submitOutbound: vi.fn(), startAgentSession, listActiveCount: () => 0,
      getNextQueued: (sessionId) => getNextDesktopQueueInput(db, sessionId), consumeQueued: () => undefined, audit })

    const firstDrain = drainer.drain(session.id)
    await vi.waitFor(() => expect(startAgentSession).toHaveBeenCalledOnce())
    await drainer.drain(session.id)
    finishFirst('busy')
    await firstDrain
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(startAgentSession).toHaveBeenCalledTimes(2)
    expect(audit).not.toHaveBeenCalledWith('outbound.drain.stalled', expect.anything())
  })
})
