import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { createMemoryAppDb } from '../../database/testHelpers'
import { appendMessage, createSession, listSessions, getMessagesPage } from '../../database/operations'
import { getDbConnection } from '../../database'
import { SqliteAgentHistory } from '../../runtime/sqliteAgentHistory'
import type { AppDatabase } from '../../database'
import { createSessionCapabilities } from './session'
import {
  registerSessionActiveStream,
  clearSessionActiveStream,
  clearAllSessionActiveStreamsForTest
} from '../../chatActiveStreams'
import type { CapabilityContext } from '../types'
import { createSqliteSessionStorage } from '../../sessionStorage/sqliteSessionStorage'
import { createSessionMessageService } from '../sessionMessageService'
import { CapabilityRegistry } from '../registry'
import { createToolkitFindExecutor } from '../toolkitTool'

let db: AppDatabase

function ctx(overrides?: Partial<CapabilityContext>): CapabilityContext {
  return {
    workDir: '/work',
    userDataDir: '/user',
    sessionId: 'current',
    requestId: 'r1',
    lane: 'desktop',
    signal: new AbortController().signal,
    appDatabase: db,
    sessionQueries: createSqliteSessionStorage(db).queries,
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
  it('从注入的查询port读取会话，无需向handler暴露数据库', async () => {
    const session = createSession(db, { name: 'injected-query-session' })
    const queries = createSqliteSessionStorage(db).queries
    const result = await findCap('action.session.list').handler({}, ctx({ appDatabase: undefined, sessionQueries: queries })) as { sessions: Array<{ id: string }> }
    expect(result.sessions.map(({ id }) => id)).toContain(session.id)
  })

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
  it('能力描述说明运行中的 turnId 可用于等待回合完成', () => {
    const status = findCap('action.session.status')
    expect(status.summary).toContain('等待')
    expect(status.returnsDoc).toContain('等待')
  })

  it('活跃请求存在 → running:true；否则 false', async () => {
    const id = await seedSession('某会话')
    const status = findCap('action.session.status')
    const idle = (await status.handler({ sessionId: id }, ctx())) as { running: boolean; turnId?: string }
    expect(idle.running).toBe(false)
    expect(idle).not.toHaveProperty('turnId')
    registerSessionActiveStream(id, 'req-9', 'turn-9')
    const running = (await status.handler({ sessionId: id }, ctx())) as { running: boolean }
    expect(running).toEqual({ running: true, turnId: 'turn-9' })
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

describe('action.session.message', () => {
  it('exposes both write capabilities through toolkit.find with act risk and strict parameters', async () => {
    const registry = new CapabilityRegistry()
    for (const descriptor of createSessionCapabilities()) registry.register(descriptor)
    const find = createToolkitFindExecutor(registry)
    for (const id of ['action.session.message.send', 'action.session.message.revoke']) {
      const result = await find({ query: id })
      expect((result.data as { matches: Array<{ id: string; risk: string }> }).matches).toContainEqual({
        id, summary: expect.any(String), usage: expect.any(String), returns: expect.any(String), risk: 'act', notes: expect.any(Array)
      })
      await expect(findCap(id).paramsSchema.parseAsync({ ownerSessionId: 'model-controlled' })).rejects.toThrow()
    }
  })

  it('requires a real user confirmation receipt and policy decision before issuing execution approval', async () => {
    const storage = createSqliteSessionStorage(db)
    const owner = await seedSession('approval owner')
    const target = await seedSession('approval target')
    const acceptance = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner, targetSessionId: target,
      requestId: 'approval-send', content: 'approved body', authorizationBinding: { workDirProfileId: 'default' } })
    const service = createSessionMessageService({ storage, requestDesktopDrain: vi.fn() })
    const prepare = service as typeof service & { prepareExecutionApproval?: (input: unknown) => boolean }
    expect(prepare.prepareExecutionApproval).toBeTypeOf('function')
    const base = { ownerSessionId: owner, requestId: acceptance.source.requestId, targetSessionId: target,
      decision: { decisionId: 'decision-ok', ruleIds: ['toolkit-act-ask'], dependencyFingerprint: 'policy-fp', verdict: 'require-confirm', policyRevision: 7 },
      receipt: 'user-receipt', answerer: 'user', authorizationGeneration: 'auth-1', runtimeGeneration: 'runtime-1' }
    expect(prepare.prepareExecutionApproval!({ ...base, decision: null,
      receipt: undefined, answerer: 'user' })).toBe(false)
    expect(prepare.prepareExecutionApproval!({ ...base,
      decision: { decisionId: 'decision-1', ruleIds: ['other-rule'], dependencyFingerprint: 'policy-fp', verdict: 'require-confirm' },
      receipt: 'user-receipt', answerer: 'user' })).toBe(false)
    expect(prepare.prepareExecutionApproval!({ ...base, answerer: 'agent' })).toBe(false)
    expect(prepare.prepareExecutionApproval!({ ...base, ownerSessionId: 'wrong-owner' })).toBe(false)
    expect(prepare.prepareExecutionApproval!({ ...base, targetSessionId: owner })).toBe(false)
    expect(storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target, requestId: acceptance.source.requestId })?.approval).toBeUndefined()
    expect(prepare.prepareExecutionApproval!(base)).toBe(true)
    expect(storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target, requestId: acceptance.source.requestId })?.approval)
      .toMatchObject({ decisionTraceRef: 'decision-ok', permitRef: 'user-receipt', policyRevision: '7', targetGeneration: expect.any(String) })
    expect(acceptance.source.kind).toBe('agent-session')
  })

  it('persists approval from the host gate only after the source message is durably accepted', async () => {
    const storage = createSqliteSessionStorage(db)
    const owner = await seedSession('approval handoff owner')
    const target = await seedSession('approval handoff target')
    const service = createSessionMessageService({ storage, requestDesktopDrain: vi.fn() })
    const send = findCap('action.session.message.send')
    const authorization = { decision: { decisionId: 'gate-decision', ruleIds: ['toolkit-act-ask'], dependencyFingerprint: 'deps-1',
      verdict: 'require-confirm', policyRevision: 4 }, receipt: 'human-receipt', answerer: 'user' as const,
      authorizationGeneration: 'auth-generation', runtimeGeneration: 'runtime-generation' }
    const result = await send.handler({ targetSessionId: target, requestId: 'approval-handoff', content: 'payload' },
      ctx({ sessionId: owner, sessionMessages: service, sessionMessageAuthorization: authorization })) as { accepted: { source: { requestId: string } } }
    const persisted = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target, requestId: result.accepted.source.requestId })
    expect(persisted?.source.authorizationBinding).toMatchObject({ decisionTraceRef: 'gate-decision', permitRef: 'human-receipt',
      ownerSessionId: owner, targetSessionId: target, targetGeneration: expect.any(String), queueScope: 'desktop',
      payloadDigest: expect.any(String), policyRevision: '4', authorizationGeneration: 'auth-generation', runtimeGeneration: 'runtime-generation' })
    expect(persisted?.approval)
      .toMatchObject({ decisionTraceRef: 'gate-decision', permitRef: 'human-receipt', ownerSessionId: owner, targetSessionId: target,
        authorizationGeneration: 'auth-generation', runtimeGeneration: 'runtime-generation' })
  })

  it('refreshes a queued approval from a new owner confirmation before the final target wake', async () => {
    const storage = createSqliteSessionStorage(db)
    const owner = await seedSession('reauthorization handoff owner')
    const target = await seedSession('reauthorization handoff target')
    const observedApprovalTraces: Array<string | undefined> = []
    const drain = vi.fn(async () => {
      observedApprovalTraces.push(storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target,
        requestId: `${owner}:reauthorization-handoff` })?.approval?.decisionTraceRef)
    })
    const service = createSessionMessageService({ storage, requestDesktopDrain: drain })
    const send = findCap('action.session.message.send')
    const authorization = (decisionId: string, receipt: string, policyRevision: number, generation: string) => ({
      decision: { decisionId, ruleIds: ['toolkit-act-ask'], dependencyFingerprint: `deps-${generation}`,
        verdict: 'require-confirm', policyRevision }, receipt, answerer: 'user' as const,
      authorizationGeneration: `auth-${generation}`, runtimeGeneration: `runtime-${generation}`
    })
    await send.handler({ targetSessionId: target, requestId: 'reauthorization-handoff', content: 'same queued body' },
      ctx({ sessionId: owner, sessionMessages: service, sessionMessageAuthorization: authorization('old-decision', 'old-receipt', 7, 'old') }))
    const refreshed = await send.handler({ targetSessionId: target, requestId: 'reauthorization-handoff', content: 'same queued body' },
      ctx({ sessionId: owner, sessionMessages: service, sessionMessageAuthorization: authorization('new-decision', 'new-receipt', 8, 'new') })) as {
        accepted: { duplicate: boolean }; wake: string
      }

    expect(refreshed).toMatchObject({ accepted: { duplicate: true }, wake: 'requested' })
    expect(observedApprovalTraces).toEqual(['old-decision', 'new-decision'])
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target, requestId: `${owner}:reauthorization-handoff` })
    expect(snapshot?.approval).toMatchObject({ decisionTraceRef: 'new-decision', permitRef: 'new-receipt', policyRevision: '8' })
    expect(snapshot?.source.authorizationBinding).toMatchObject({ decisionTraceRef: 'old-decision', permitRef: 'old-receipt', policyRevision: '7' })
  })

  it('discovers send/revoke as act capabilities and scopes writes to the authenticated session on desktop', async () => {
    const owner = await seedSession('消息发送者')
    const target = await seedSession('消息接收者')
    const storage = createSqliteSessionStorage(db)
    const drain = vi.fn()
    const service = createSessionMessageService({ storage, requestDesktopDrain: drain })
    const messageContext = ctx({ sessionId: owner, requestId: 'message-tool-turn', lane: 'desktop', sessionMessages: service })
    const send = findCap('action.session.message.send')
    const revoke = findCap('action.session.message.revoke')
    expect(send.risk).toBe('act')
    expect(revoke.risk).toBe('act')
    const sent = await send.handler({ targetSessionId: target, requestId: 'send-key', content: 'hello' }, messageContext) as {
      accepted: { receipt: { requestId: string; queuedMessageId: string }; duplicate: boolean }; wake: string
    }
    expect(sent).toMatchObject({ accepted: { receipt: { requestId: `${owner}:send-key`, queuedMessageId: expect.any(String) }, duplicate: false }, wake: 'requested' })
    expect(drain).toHaveBeenCalledWith(target)
    expect(storage.queries.readMessage({ sessionId: target, messageId: sent.accepted.receipt.queuedMessageId })?.content).toContain('hello')
    await expect(send.handler({ targetSessionId: target, requestId: 'bad-key', content: 'forged owner' }, ctx({ ...messageContext, sessionId: undefined } as never)))
      .rejects.toThrow('SESSION_MESSAGE_CALLER_UNAVAILABLE')
    expect(drain).toHaveBeenCalledTimes(1)
    const revoked = await revoke.handler({ requestId: 'send-key' }, messageContext) as { kind: string }
    expect(revoked.kind).toBe('revoked')
    expect(drain).toHaveBeenCalledTimes(2)
    await expect(send.handler({ targetSessionId: owner, requestId: 'send-key', content: 'different target' }, messageContext))
      .rejects.toThrow('SESSION_MESSAGE_REQUEST_CONFLICT')
    const duplicate = await send.handler({ targetSessionId: target, requestId: 'send-key', content: 'hello' }, messageContext) as {
      accepted: { duplicate: boolean }
    }
    expect(duplicate.accepted.duplicate).toBe(true)
  })

  it('rejects hidden/internal targets and non-desktop lanes before persisting or waking', async () => {
    const owner = await seedSession('权限 owner')
    const hidden = createSession(db, { name: 'hidden target', ownership: 'user', visibility: 'hidden' })
    const internal = createSession(db, { name: 'internal target', ownership: 'internal', visibility: 'visible' })
    const drain = vi.fn()
    const service = createSessionMessageService({ storage: createSqliteSessionStorage(db), requestDesktopDrain: drain })
    const send = findCap('action.session.message.send')
    const ctxFor = (targetSessionId: string, lane = 'desktop') => ctx({ sessionId: owner, requestId: `reject-${targetSessionId}`,
      lane, sessionMessages: service })
    for (const targetSessionId of [hidden.id, internal.id]) {
      await expect(send.handler({ targetSessionId, requestId: `key-${targetSessionId}`, content: 'must not persist' }, ctxFor(targetSessionId)))
        .rejects.toThrow('SESSION_MESSAGE_TARGET_UNAVAILABLE')
    }
    await expect(send.handler({ targetSessionId: owner, requestId: 'remote-key', content: 'must not persist' }, ctxFor(owner, 'wechat')))
      .rejects.toThrow('SESSION_MESSAGE_DESKTOP_ONLY')
    expect(drain).not.toHaveBeenCalled()
    expect(createSqliteSessionStorage(db).queries.readMessages({ sessionId: owner })).toHaveLength(0)
  })

  it('rejects remote targets, cross-profile targets, remote owners, and a missing lane without writes or wakes', async () => {
    const owner = createSession(db, { name: 'desktop-owner', ownership: 'user', workDirProfileId: 'profile-a' })
    const remote = createSession(db, { name: 'remote-primary', ownership: 'remote', visibility: 'primary', workDirProfileId: 'profile-a' })
    const automation = createSession(db, { name: 'automation-primary', ownership: 'automation', visibility: 'primary', workDirProfileId: 'profile-a' })
    const otherProfile = createSession(db, { name: 'other-profile', ownership: 'user', workDirProfileId: 'profile-b' })
    const remoteOwner = createSession(db, { name: 'remote-owner', ownership: 'remote', visibility: 'primary', workDirProfileId: 'profile-a' })
    const drain = vi.fn()
    const storage = createSqliteSessionStorage(db)
    const service = createSessionMessageService({ storage, requestDesktopDrain: drain })
    const send = findCap('action.session.message.send')
    for (const [caller, target, lane] of [[owner.id, remote.id, 'desktop'], [owner.id, automation.id, 'desktop'], [owner.id, otherProfile.id, 'desktop'],
      [remoteOwner.id, owner.id, 'desktop'], [owner.id, owner.id, undefined]] as const) {
      await expect(send.handler({ targetSessionId: target, requestId: `reject-${randomUUID()}`, content: 'no write' },
        ctx({ sessionId: caller, lane, sessionMessages: service }))).rejects.toThrow()
    }
    expect(drain).not.toHaveBeenCalled()
    expect(storage.queries.readMessages({ sessionId: remote.id })).toHaveLength(0)
    expect(storage.queries.readMessages({ sessionId: automation.id })).toHaveLength(0)
    expect(storage.queries.readMessages({ sessionId: otherProfile.id })).toHaveLength(0)
    expect(storage.queries.readMessages({ sessionId: owner.id })).toHaveLength(0)
  })

  it('keeps the durable receipt when drain wake fails', async () => {
    const owner = await seedSession('wake owner')
    const target = await seedSession('wake target')
    const service = createSessionMessageService({ storage: createSqliteSessionStorage(db), requestDesktopDrain: () => { throw new Error('wake failed') } })
    const result = await findCap('action.session.message.send').handler({ targetSessionId: target, requestId: 'wake-key', content: 'durable' },
      ctx({ sessionId: owner, requestId: 'wake-tool-turn', lane: 'desktop', sessionMessages: service })) as { accepted: { receipt: { queuedMessageId: string } }; wake: string }
    expect(result.wake).toBe('retry-pending')
    expect(createSqliteSessionStorage(db).commands.agentSessionMessages.readSettlement({ ownerSessionId: owner, requestId: `${owner}:wake-key` }))
      .toMatchObject({ kind: 'queued', targetSessionId: target, messageId: result.accepted.receipt.queuedMessageId })
  })

  it('replays the original acceptance after target deletion without restoring its message', async () => {
    const owner = await seedSession('deleted-target owner')
    const target = await seedSession('deleted target')
    const storage = createSqliteSessionStorage(db)
    const service = createSessionMessageService({ storage, requestDesktopDrain: vi.fn() })
    const send = findCap('action.session.message.send')
    const messageContext = ctx({ sessionId: owner, requestId: 'delete-replay-turn', lane: 'desktop', sessionMessages: service })
    const first = await send.handler({ targetSessionId: target, requestId: 'delete-replay', content: 'original' }, messageContext) as {
      accepted: { receipt: { queuedMessageId: string }; source: { payloadSha256: string } }
    }
    storage.commands.deleteSession(target)
    const replay = await send.handler({ targetSessionId: target, requestId: 'delete-replay', content: 'original' }, messageContext) as {
      accepted: { duplicate: boolean; receipt: { queuedMessageId?: string }; source: { payloadSha256: string } }
    }
    expect(replay.accepted.duplicate).toBe(true)
    expect(replay.accepted.source.payloadSha256).toBe(first.accepted.source.payloadSha256)
    expect(replay.accepted.receipt.queuedMessageId).toBeUndefined()
    await expect(send.handler({ targetSessionId: target, requestId: 'delete-replay', content: 'changed' }, messageContext))
      .rejects.toThrow('SESSION_MESSAGE_TARGET_UNAVAILABLE')
  })
})

describe('action.session.read', () => {
  it('truncated agent-session messages retain host-verified source metadata', async () => {
    const owner = await seedSession('source metadata owner')
    const target = await seedSession('source metadata target')
    const storage = createSqliteSessionStorage(db)
    const service = createSessionMessageService({ storage, requestDesktopDrain: vi.fn() })
    const accepted = await service.send({ ownerSessionId: owner, targetSessionId: target, requestId: 'source-read', content: 'x'.repeat(5000) })
    const read = await findCap('action.session.read').handler({ sessionId: target }, ctx()) as {
      messages: Array<{ content: string; truncated?: boolean; source?: { kind: string; ownerSessionId: string; requestId: string } }>
    }
    expect(read.messages[0]).toMatchObject({ truncated: true, source: {
      kind: 'agent-session', ownerSessionId: owner, requestId: accepted.accepted.source.requestId
    } })
    expect(read.messages[0]!.content).not.toContain('agent-session')
  })

  it('prepares the chat body after visibility checks and before selecting export rows', async () => {
    const id = await seedSession('projection capability read', ['body'])
    const events: string[] = []
    const base = createSqliteSessionStorage(db).queries
    const queries = { ...base,
      readPreparedExportPage: async (input: { sessionId: string; fromSequence: number; pageSize: number; prepared?: unknown }) => {
        events.push(`prepared-export:${input.fromSequence}:${input.pageSize}`)
        return base.readExportPage(input)
      },
      readExportPage: (input: Parameters<typeof base.readExportPage>[0]) => {
        events.push('select-export')
        return base.readExportPage(input)
      } }

    await findCap('action.session.read').handler({ sessionId: id }, ctx({ sessionQueries: queries,
      ensureChatBodyV1: async ({ sessionId }) => { events.push(`ensure:${sessionId}`) } }))

    expect(events).toEqual([`ensure:${id}`, 'prepared-export:0:20'])
  })

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

  it('canonical-only 正文清空并丢失 cache 后仍按 sequence 游标跨页读取', async () => {
    const id = await seedSession('canonical-only 分页导出', ['canonical page 0', 'canonical page 1', 'canonical page 2'])
    const conn = getDbConnection(db)
    const rows = conn.prepare('SELECT id,role,content,timestamp FROM messages WHERE session_id=? ORDER BY sequence')
      .all(id) as Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
    const history = new SqliteAgentHistory(conn, 1, Date.now, id)
    await history.appendBatch([{
      invocationId: 'capability-canonical-page-invocation', turnId: 'capability-canonical-page-turn', sequence: 1, schemaVersion: 1,
      eventId: 'capability-canonical-page-context', idempotencyKey: 'capability-canonical-page-context',
      kind: 'invocation-context-committed',
      payload: { messages: rows.map(({ id: messageId, role, content, timestamp }) => ({ id: messageId, role, content, timestamp })) }
    }], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(id)

    const read = findCap('action.session.read')
    const page1 = await read.handler({ sessionId: id, limit: 2 }, ctx()) as {
      messages: Array<{ sequence: number; content: string }>; nextSequence: number; hasMore: boolean
    }
    expect(page1).toMatchObject({
      messages: [{ sequence: 0, content: 'canonical page 0' }, { sequence: 1, content: 'canonical page 1' }],
      nextSequence: 2, hasMore: true
    })
    const page2 = await read.handler({ sessionId: id, cursor: page1.nextSequence, limit: 2 }, ctx()) as {
      messages: Array<{ sequence: number; content: string }>; nextSequence: number; hasMore: boolean
    }
    expect(page2).toMatchObject({ messages: [{ sequence: 2, content: 'canonical page 2' }], nextSequence: 3, hasMore: false })
    expect(page2.messages).toHaveLength(1)
    expect(conn.prepare("SELECT cache_key FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(id))
      .toBeUndefined()
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

  it('消息删除产生 sequence 空洞后，返回真实 sequence 与 nextSequence 口径一致（评审 S3）', async () => {
    const { getDbConnection } = await import('../../database')
    const id = await seedSession('空洞会话', ['消息 0', '消息 1', '消息 2'])
    // 直接删除中间一行制造 sequence 空洞（sequence=1）
    getDbConnection(db).prepare('DELETE FROM messages WHERE session_id = ? AND sequence = 1').run(id)
    const read = findCap('action.session.read')
    const page = (await read.handler({ sessionId: id }, ctx())) as {
      messages: Array<{ sequence: number; content: string }>
      nextSequence: number
    }
    expect(page.messages.map((m) => m.sequence)).toEqual([0, 2]) // 真实 sequence，非 0/1
    expect(page.nextSequence).toBe(3)
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
