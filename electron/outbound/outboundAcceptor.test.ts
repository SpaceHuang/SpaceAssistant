import { describe, expect, it, vi } from 'vitest'
import { createOutboundAcceptor, decideOutbound, type OutboundSnapshot } from './outboundAcceptor'
import type { OutboundSubmitIntent } from '../../src/shared/outboundProtocol'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { summarizeFailedInvocation } from './outboundAcceptor'
import { TransactionCommitUnknownError } from '../database/transaction'

function makeSnapshot(overrides: Partial<OutboundSnapshot> = {}): OutboundSnapshot {
  return {
    isDev: true,
    sessionExists: true,
    sessionRunning: false,
    activeTurnCount: 0,
    maxParallel: 3,
    apiKeyPresent: true,
    queuedCount: 0,
    maxQueueSize: 10,
    wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: true },
    sessionSkillsState: { manualActivated: [], manualDisabled: [] },
    ...overrides
  }
}

const io = {
  listSkills: vi.fn(async () => []),
  getSkill: vi.fn(async () => null),
  wikiInit: vi.fn(async () => ({ ok: true as const, rootPath: 'llm-wiki', skillInstalled: true })),
  wikiStatus: vi.fn(async () => ({
    enabled: true,
    rootPath: 'llm-wiki',
    initialized: true,
    pageCount: 1,
    rawCount: 0
  })),
  wikiImportRaw: vi.fn(async ({ srcRelPath }: { srcRelPath: string }) => ({
    ok: true as const,
    rawRelPath: srcRelPath,
    copied: false
  }))
}

describe('decideOutbound（出站决定矩阵）', () => {
  it.each(['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'])('recognizes exact continuation phrase %s', async (text) => {
    const d = await decideOutbound({ text: ` ${text} ` }, makeSnapshot(), io)
    expect(d).toMatchObject({ action: 'start-turn', continuationIntent: { kind: 'exact-continue' } })
  })

  it('treats continuation phrase with extra user text as a normal turn with continuation context', async () => {
    const d = await decideOutbound({ text: '继续检查第二个文件' }, makeSnapshot(), io)
    expect(d).toMatchObject({ action: 'start-turn', text: '继续检查第二个文件', continuationIntent: { kind: 'follow-up' } })
  })

  it('does not classify an unrelated new topic as a continuation', async () => {
    const d = await decideOutbound({ text: '顺便帮我查一下天气' }, makeSnapshot(), io)
    expect(d).toEqual({ action: 'start-turn', text: '顺便帮我查一下天气' })
  })

  it('test-pop run → local-command（无需会话，开发模式）', async () => {
    const d = await decideOutbound({ text: '/test-pop' }, makeSnapshot({ sessionExists: false }), io)
    expect(d).toEqual({ action: 'local-command', command: { kind: 'test-pop-run' } })
  })

  it('test-pop 非开发模式 → hint-only', async () => {
    const d = await decideOutbound({ text: '/test-pop' }, makeSnapshot({ isDev: false }), io)
    expect(d).toMatchObject({ action: 'hint-only' })
    if (d.action === 'hint-only') expect(d.hint).toContain('仅在开发模式下可用')
  })

  it('普通文本但无会话 → 拒绝（会话创建是主进程决定，失败不得静默降级）', async () => {
    const d = await decideOutbound({ text: '你好' }, makeSnapshot({ sessionExists: false }), io)
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_SESSION_NOT_FOUND' })
  })

  it('未运行但跨会话并发满 → 拒绝', async () => {
    const d = await decideOutbound(
      { text: '你好' },
      makeSnapshot({ activeTurnCount: 3, maxParallel: 3 }),
      io
    )
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_MAX_PARALLEL_REACHED' })
  })

  it('test-cards run 开发模式且未运行 → local-command（渲染端本地预览，不发 turn）', async () => {
    const d = await decideOutbound({ text: '/test-cards' }, makeSnapshot(), io)
    expect(d).toEqual({ action: 'local-command', command: { kind: 'test-cards-run' } })
  })

  it('test-cards run 开发模式但会话运行中 → 排队', async () => {
    const d = await decideOutbound({ text: '/test-cards' }, makeSnapshot({ sessionRunning: true }), io)
    expect(d).toMatchObject({ action: 'enqueue' })
  })

  it('排队已满 → 拒绝', async () => {
    const d = await decideOutbound(
      { text: '你好' },
      makeSnapshot({ sessionRunning: true, queuedCount: 10, maxQueueSize: 10 }),
      io
    )
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_QUEUE_FULL' })
  })

  it('缺 API Key → 拒绝', async () => {
    const d = await decideOutbound({ text: '你好' }, makeSnapshot({ apiKeyPresent: false }), io)
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_API_KEY_MISSING' })
  })

  it('wiki 命令型（help）→ hint-only', async () => {
    const d = await decideOutbound({ text: '/wiki help' }, makeSnapshot(), io)
    expect(d.action).toBe('hint-only')
  })

  it('wiki run 型（query）→ start-turn，携带 skillsState 与 wikiModeActive', async () => {
    const d = await decideOutbound({ text: '/wiki query 如何重构' }, makeSnapshot(), io)
    expect(d).toMatchObject({ action: 'start-turn', wikiModeActive: true })
    if (d.action === 'start-turn') {
      expect(d.text).toBe('如何重构')
      expect(d.skillsState?.manualActivated).toContain('llm-wiki')
    }
  })

  it('skill 命令型（list）→ hint-only', async () => {
    const d = await decideOutbound({ text: '/skill list' }, makeSnapshot(), io)
    expect(d.action).toBe('hint-only')
  })

  it('会话运行中 + 普通文本 → 排队（不是拒绝也不是并发发起）', async () => {
    const d = await decideOutbound({ text: '继续' }, makeSnapshot({ sessionRunning: true }), io)
    expect(d).toMatchObject({ action: 'enqueue', text: '继续' })
  })

  it('会话运行中 + reuse-user 意图（重试）→ 拒绝（对齐渲染端运行守卫；排水器在 active 清零后才驱动）', async () => {
    const d = await decideOutbound(
      {
        text: '继续',
        contextIntent: {
          kind: 'reuse-user',
          currentUser: { message: { id: 'u1' } as never, order: { kind: 'persisted', sequence: 3 } },
          requestId: 'req-1'
        }
      },
      makeSnapshot({ sessionRunning: true }),
      io
    )
    expect(d).toMatchObject({ action: 'reject', reason: 'OUTBOUND_SESSION_RUNNING' })
  })

  it('普通文本 + 未运行 → start-turn（create-user 原文）', async () => {
    const d = await decideOutbound({ text: '  你好  ' }, makeSnapshot(), io)
    expect(d).toMatchObject({ action: 'start-turn', text: '你好' })
  })
})

describe('canonical History failure summary', () => {
  const evt = (sequence: number, kind: string, payload: unknown) => ({ invocationId: 'inv-failed', turnId: 'turn-failed', sequence, schemaVersion: 1, eventId: `e-${sequence}`, idempotencyKey: `i-${sequence}`, kind, payload }) as never

  it('reports only finished successful writes as completed and preserves unsettled side effects as unknown', () => {
    const summary = summarizeFailedInvocation({ invocationId: 'inv-failed', version: 5, schemaVersion: 1, events: [
      evt(1, 'invocation-context-committed', { requiredUserMessage: { message: { content: 'edit notes' } } }),
      evt(2, 'tool-call-started', { toolCallId: 'w1', toolName: 'write_file', input: { path: 'notes.md' } }),
      evt(3, 'tool-call-finished', { toolCallId: 'w1', toolName: 'write_file', input: { path: 'notes.md' }, result: { success: true, summary: 'wrote intro' } }),
      evt(4, 'tool-call-started', { toolCallId: 'w2', toolName: 'edit_file', input: { path: 'notes.md' } }),
      evt(5, 'invocation-failed', { message: 'middle edit failed' })
    ] } as never, 'inv-failed', 'turn-failed')
    expect(summary.summary).toContain('wrote intro')
    expect(summary.summary).toContain('middle edit failed')
    expect(summary.summary).toContain('Side-effect state unknown')
    expect(summary.state).toBe('unknown')
  })

  it('does not infer a completed write from preview-only metadata', () => {
    const summary = summarizeFailedInvocation({ invocationId: 'inv-failed', version: 2, schemaVersion: 1, events: [
      evt(1, 'tool-call-started', { toolCallId: 'w1', toolName: 'write_file', input: { path: 'notes.md' } }),
      evt(2, 'invocation-failed', { autoApprovedWrite: { preview: 'would write' } })
    ] } as never, 'inv-failed', 'turn-failed')
    expect(summary.summary).not.toContain('would write')
    expect(summary.state).toBe('unknown')
  })

  it('uses canonical success flags and the committed proposal to describe a failed write', () => {
    const summary = summarizeFailedInvocation({ invocationId: 'inv-failed', version: 4, schemaVersion: 1, events: [
      evt(1, 'model-response-committed', { toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'notes.md' } }] }),
      evt(2, 'tool-call-started', { toolCallId: 'w1', toolName: 'write_file' }),
      evt(3, 'tool-call-finished', { toolCallId: 'w1', success: false, result: { success: true, message: 'preview generated' } }),
      evt(4, 'invocation-failed', { message: 'write failed' })
    ] } as never, 'inv-failed', 'turn-failed')
    expect(summary.summary).toContain('Failed tool results: history#3 write_file notes.md')
    expect(summary.summary).not.toContain('Committed successful tool results: history#3')
  })

  it('treats a completed invocation after a historical failure as a newer accepted task boundary', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, getDbConnection } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-boundary-')
    try {
      const session = createSession(temp.db, { name: 'boundary' })
      appendMessage(temp.db, { id: 'prior-user', sessionId: session.id, role: 'user', content: 'old task', timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: 'old-inv', turnId: 'old-turn', sequence: 1, schemaVersion: 1, eventId: '1', idempotencyKey: '1', kind: 'invocation-context-committed', payload: { messages: [], requiredUserMessage: { id: 'prior-user', message: { role: 'user', content: 'old task' } } } },
        { invocationId: 'old-inv', turnId: 'old-turn', sequence: 2, schemaVersion: 1, eventId: '2', idempotencyKey: '2', kind: 'invocation-failed', payload: { status: 'failed', message: 'old failure' } }
      ], 0)
      await history.appendBatch([
        { invocationId: 'new-inv', turnId: 'new-turn', sequence: 1, schemaVersion: 1, eventId: '3', idempotencyKey: '3', kind: 'invocation-context-committed', payload: { messages: [] } },
        { invocationId: 'new-inv', turnId: 'new-turn', sequence: 2, schemaVersion: 1, eventId: '4', idempotencyKey: '4', kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
      expect(history.listInvocationIdsForSession(session.id)).toEqual(['old-inv', 'new-inv'])
    } finally { temp.cleanup() }
  })
})

describe('continuation intent acceptance persistence', () => {
  it('returns a typed checkpoint-started status and hides the internal continuation ID on retries', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, createPersistedTurn, getDbConnection, getMessages } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-started-status-')
    try {
      const session = createSession(temp.db, { name: 'continuation-started-status' })
      appendMessage(temp.db, { id: 'status-source-assistant', sessionId: session.id, role: 'assistant', content: 'failed task', timestamp: 1, status: 'failed' })
      createPersistedTurn(temp.db, { turnId: 'status-source-turn', requestId: 'status-source-invocation', sessionId: session.id, assistantMessageId: 'status-source-assistant', state: 'terminal', outcome: 'failed' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: 'status-source-invocation', turnId: 'status-source-turn', sequence: 1, schemaVersion: 1, eventId: 'status-source-1', idempotencyKey: 'status-source-i1', kind: 'invocation-context-committed', payload: { messages: [] } },
        { invocationId: 'status-source-invocation', turnId: 'status-source-turn', sequence: 2, schemaVersion: 1, eventId: 'status-source-2', idempotencyKey: 'status-source-i2', kind: 'invocation-failed', payload: { status: 'failed', message: 'failed' } }
      ], 0)
      const appendHintMessage = vi.fn()
      const startContinuation = vi.fn(async () => ({ continuationId: 'private-continuation-id', targetTurnId: 'continued-turn', status: 'running' }))
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn: vi.fn(), startContinuation, newRequestId: () => 'generated', audit: () => undefined
      })

      const intent = { sessionId: session.id, text: '继续', requestId: 'stable-checkpoint-continue' }
      const first = await acceptor.submitOutbound(intent)
      const retry = await acceptor.submitOutbound(intent)
      expect(first).toMatchObject({ accepted: 'local-command', sessionId: session.id, command: { kind: 'continuation-started', messageId: expect.any(String), sequence: expect.any(Number) } })
      expect(retry).toEqual(first)
      expect(JSON.stringify(first)).not.toContain('private-continuation-id')
      expect(startContinuation).toHaveBeenCalledTimes(1)
      expect(appendHintMessage).not.toHaveBeenCalled()
      const statusMessages = getMessages(temp.db, session.id).filter((message) => message.skillHints?.some((hint) => hint.status === 'continuation-started'))
      expect(statusMessages).toHaveLength(1)
      if (first.accepted !== 'local-command' || first.command.kind !== 'continuation-started') throw new Error('expected continuation-started command')
      if (retry.accepted !== 'local-command' || retry.command.kind !== 'continuation-started') throw new Error('expected continuation-started retry command')
      expect(statusMessages[0]?.id).toBe(first.command.messageId)
      expect(statusMessages[0]?.id).toBe(retry.command.messageId)
      expect(statusMessages[0]?.skillHints?.[0]).toMatchObject({ category: 'status', status: 'continuation-started', text: '' })
    } finally { temp.cleanup() }
  })

  it('does not create an intent row for regular requests and keeps continuation routing request ID in the accepted turn', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, getDbConnection, getPersistedTurn } = await import('../database')
    const temp = createTempDatabase('sa-continuation-intent-')
    try {
      const session = createSession(temp.db, { name: 'intent' })
      const started = vi.fn(async ({ turnIntent }: { turnIntent: { requestId: string; sessionId: string } }) => ({
        turnId: `target-${turnIntent.requestId}`,
        assistantMessage: { id: 'assistant', sessionId: turnIntent.sessionId, role: 'assistant', content: '', timestamp: 1, status: 'streaming' } as never
      }))
      const acceptor = createOutboundAcceptor({
        db: temp.db,
        turnRuntime: { listActive: () => [] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3,
        maxQueueSize: 10, readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn: started, newRequestId: () => 'generated', audit: () => undefined
      })
      const result = await acceptor.submitOutbound({ sessionId: session.id, text: '继续检查第二个文件', requestId: 'stable-input-1', contextIntent: { kind: 'create-user', text: '继续检查第二个文件', attachments: [{ id: 'asset-1', name: 'image.png', mimeType: 'image/png' } as never] } })
      expect(result).toMatchObject({ accepted: 'turn-started', turnId: 'target-stable-input-1' })
      expect(started).toHaveBeenCalledWith(expect.objectContaining({ turnIntent: expect.objectContaining({
        requestId: 'stable-input-1', input: expect.objectContaining({ text: '继续检查第二个文件', attachments: expect.arrayContaining([expect.objectContaining({ id: 'asset-1' })]) })
      }) }))
      expect(getDbConnection(temp.db).prepare('SELECT route,status,raw_text,attachments_json FROM continuation_intents WHERE request_id=?').get('stable-input-1')).toMatchObject({ route: 'ordinary', status: 'accepted_turn', raw_text: '继续检查第二个文件' })
      expect(getPersistedTurn(temp.db, 'target-stable-input-1')).toBeUndefined() // adapter owns actual Turn persistence in production
      const conflict = await acceptor.submitOutbound({ sessionId: session.id, text: '继续检查第二个文件', requestId: 'stable-input-1', attachments: [] })
      expect(conflict).toMatchObject({ rejected: { reason: 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT' } })
      expect(started).toHaveBeenCalledTimes(1)
    } finally {
      temp.cleanup()
    }
  })

  it('persists ambiguous source selection and returns the same request for explicit normal-turn fallback', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, getDbConnection } = await import('../database')
    const temp = createTempDatabase('sa-continuation-select-')
    try {
      const session = createSession(temp.db, { name: 'choose' })
      for (let index = 0; index < 2; index++) {
        appendMessage(temp.db, { id: `failed-${index}`, sessionId: session.id, role: 'assistant', content: `failed ${index}`, timestamp: index + 1, status: 'failed' })
        const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
        const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
        await history.appendBatch([
          { invocationId: `inv-${index}`, turnId: `turn-${index}`, sequence: 1, schemaVersion: 1, eventId: `e-${index}-1`, idempotencyKey: `i-${index}-1`, kind: 'invocation-context-committed', payload: { messages: [] } },
          { invocationId: `inv-${index}`, turnId: `turn-${index}`, sequence: 2, schemaVersion: 1, eventId: `e-${index}-2`, idempotencyKey: `i-${index}-2`, kind: 'invocation-failed', payload: { status: 'failed', message: `failed ${index}` } }
        ], 0)
      }
      const started = vi.fn(async ({ turnIntent }: { turnIntent: { requestId: string; sessionId: string } }) => ({ turnId: `turn-${turnIntent.requestId}`, assistantMessage: { id: 'assistant', sessionId: turnIntent.sessionId, role: 'assistant', content: '', timestamp: 3, status: 'streaming' } as never }))
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn: started, newRequestId: () => 'gen', audit: () => undefined
      })
      const intent = { sessionId: session.id, text: '继续', requestId: 'selection-1' }
      expect(await acceptor.submitOutbound(intent)).toMatchObject({ rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } })
      expect(getDbConnection(temp.db).prepare('SELECT status FROM continuation_intents WHERE request_id=?').get('selection-1')).toEqual({ status: 'needs_source_selection' })
      expect(await acceptor.submitOutbound({ ...intent, sourceSelection: { asOrdinaryTurn: true } })).toMatchObject({ accepted: 'turn-started', turnId: 'turn-selection-1' })
      expect(started).toHaveBeenCalledTimes(1)
    } finally { temp.cleanup() }
  })

  it('routes an explicit latest-source choice to the newest failed invocation', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, getDbConnection } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-latest-')
    try {
      const session = createSession(temp.db, { name: 'latest' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      for (let index = 0; index < 2; index++) {
        appendMessage(temp.db, { id: `latest-failed-${index}`, sessionId: session.id, role: 'assistant', content: `failed ${index}`, timestamp: index + 1, status: 'failed' })
        await history.appendBatch([
          { invocationId: `latest-inv-${index}`, turnId: `latest-turn-${index}`, sequence: 1, schemaVersion: 1, eventId: `latest-${index}-1`, idempotencyKey: `latest-i-${index}-1`, kind: 'invocation-context-committed', payload: { messages: [] } },
          { invocationId: `latest-inv-${index}`, turnId: `latest-turn-${index}`, sequence: 2, schemaVersion: 1, eventId: `latest-${index}-2`, idempotencyKey: `latest-i-${index}-2`, kind: 'invocation-failed', payload: { status: 'failed', message: `failed ${index}` } }
        ], 0)
      }
      const started = vi.fn(async ({ turnIntent }: { turnIntent: { requestId: string; sessionId: string; config?: { continuationContext?: { sourceInvocationId?: string } } } }) => ({ turnId: `turn-${turnIntent.requestId}`, assistantMessage: { id: 'assistant', sessionId: turnIntent.sessionId, role: 'assistant', content: '', timestamp: 3, status: 'streaming' } as never }))
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn: started, newRequestId: () => 'gen', audit: () => undefined
      })
      const intent = { sessionId: session.id, text: '继续', requestId: 'latest-choice' }
      expect(await acceptor.submitOutbound(intent)).toMatchObject({ rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } })
      expect(await acceptor.submitOutbound({ ...intent, sourceSelection: { chooseLatest: true } })).toMatchObject({ accepted: 'turn-started' })
      expect(started).toHaveBeenCalledWith(expect.objectContaining({ turnIntent: expect.objectContaining({ requestId: 'latest-choice', config: expect.objectContaining({ continuationContext: expect.objectContaining({ sourceInvocationId: 'latest-inv-1' }) }) }) }))
    } finally { temp.cleanup() }
  })

  it('does not attach an older failure after a newer user task has already been accepted', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, createPersistedTurn, getDbConnection } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-stale-source-')
    try {
      const session = createSession(temp.db, { name: 'stale-source' })
      appendMessage(temp.db, { id: 'old-user', sessionId: session.id, role: 'user', content: 'old task', timestamp: 1, status: 'sent' })
      appendMessage(temp.db, { id: 'old-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 2, status: 'failed' })
      createPersistedTurn(temp.db, { turnId: 'old-turn', requestId: 'old-invocation', sessionId: session.id, assistantMessageId: 'old-assistant', state: 'terminal', outcome: 'failed' })
      appendMessage(temp.db, { id: 'new-user', sessionId: session.id, role: 'user', content: 'new task already accepted', timestamp: 3, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: 'old-turn', turnId: 'old-turn', sequence: 1, schemaVersion: 1, eventId: 'stale-1', idempotencyKey: 'stale-i1', kind: 'invocation-context-committed', payload: { messages: [], requiredUserMessage: { id: 'old-user', message: { role: 'user', content: 'old task' } } } },
        { invocationId: 'old-turn', turnId: 'old-turn', sequence: 2, schemaVersion: 1, eventId: 'stale-2', idempotencyKey: 'stale-i2', kind: 'invocation-failed', payload: { status: 'failed', message: 'old failure' } }
      ], 0)
      const started = vi.fn(async ({ turnIntent }: { turnIntent: { requestId: string; sessionId: string; config?: { continuationContext?: unknown }; continuationAcceptance?: { route: string } } }) => ({ turnId: `turn-${turnIntent.requestId}`, assistantMessage: { id: 'new-assistant', sessionId: turnIntent.sessionId, role: 'assistant', content: '', timestamp: 4, status: 'streaming' } as never }))
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn: started, newRequestId: () => 'gen', audit: () => undefined
      })
      expect(await acceptor.submitOutbound({ sessionId: session.id, text: '继续', requestId: 'new-continue' })).toMatchObject({ accepted: 'turn-started' })
      expect(started).toHaveBeenCalledWith(expect.objectContaining({ turnIntent: expect.objectContaining({ continuationAcceptance: expect.objectContaining({ route: 'ordinary' }), config: {} }) }))
    } finally { temp.cleanup() }
  })

  it('keeps the failure summary and stable request id through queue claim into Turn config', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, getDbConnection, getNextQueuedMessage, claimQueuedTurnAtomically, getPersistedTurn } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-queued-context-')
    try {
      const session = createSession(temp.db, { name: 'queued-context' })
      appendMessage(temp.db, { id: 'queue-source-assistant', sessionId: session.id, role: 'assistant', content: 'failed source', timestamp: 1, status: 'failed' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: 'queue-source', turnId: 'queue-source-turn', sequence: 1, schemaVersion: 1, eventId: 'queue-src-1', idempotencyKey: 'queue-src-i1', kind: 'invocation-context-committed', payload: { messages: [], requiredUserMessage: { id: 'prior-user', message: { role: 'user', content: 'edit the files' } } } },
        { invocationId: 'queue-source', turnId: 'queue-source-turn', sequence: 2, schemaVersion: 1, eventId: 'queue-src-2', idempotencyKey: 'queue-src-i2', kind: 'invocation-failed', payload: { status: 'failed', message: 'stopped after first write' } }
      ], 0)
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [{ turnId: 'busy-turn', sessionId: session.id }] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn: vi.fn(), newRequestId: () => 'generated', audit: () => undefined
      })
      const requestId = 'queued-continuation-stable'
      const accepted = await acceptor.submitOutbound({ sessionId: session.id, text: '继续检查', requestId, contextIntent: { kind: 'create-user', text: '继续检查', attachments: [{ id: 'image-1', name: 'image.png', mimeType: 'image/png' } as never] } })
      expect(accepted).toMatchObject({ accepted: 'queued', queued: { requestId } })
      const queued = getNextQueuedMessage(temp.db, session.id)!
      claimQueuedTurnAtomically(temp.db, { sessionId: session.id, userMessageId: queued.message.id, turnId: 'queued-continuation-turn', assistantMessageId: 'queued-continuation-assistant', requestId })
      expect(getPersistedTurn(temp.db, 'queued-continuation-turn')?.executionConfig?.continuationContext).toMatchObject({ sourceInvocationId: 'queue-source', sourceTurnId: 'queue-source-turn', state: 'known' })
      expect(getPersistedTurn(temp.db, 'queued-continuation-turn')?.executionConfig?.continuationContext?.summary).toContain('stopped after first write')
      expect(getDbConnection(temp.db).prepare('SELECT status,target_id FROM continuation_intents WHERE request_id=?').get(requestId)).toMatchObject({ status: 'accepted_turn', target_id: 'queued-continuation-turn' })
      expect(await acceptor.submitOutbound({ sessionId: session.id, text: '继续检查', requestId, contextIntent: { kind: 'create-user', text: '继续检查', attachments: [{ id: 'image-1', name: 'image.png', mimeType: 'image/png' } as never] } })).toMatchObject({ accepted: 'turn-started', turnId: 'queued-continuation-turn' })
    } finally { temp.cleanup() }
  })

  it('queues continuation input with attachments while the latest canonical History is still running', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, createPersistedTurn, getDbConnection, getNextQueuedMessage, claimQueuedTurnAtomically, getPersistedTurn } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-running-history-')
    try {
      const session = createSession(temp.db, { name: 'running-history' })
      appendMessage(temp.db, { id: 'prior-failed-assistant', sessionId: session.id, role: 'assistant', content: 'prior failed task', timestamp: 1, status: 'failed' })
      createPersistedTurn(temp.db, { turnId: 'prior-failed-turn', requestId: 'prior-failed-invocation', sessionId: session.id, assistantMessageId: 'prior-failed-assistant', state: 'terminal', outcome: 'failed' })
      appendMessage(temp.db, { id: 'active-user', sessionId: session.id, role: 'user', content: 'new task currently running', timestamp: 2, status: 'sent' })
      appendMessage(temp.db, { id: 'active-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 3, status: 'streaming' })
      createPersistedTurn(temp.db, { turnId: 'active-turn', requestId: 'active-invocation', sessionId: session.id, assistantMessageId: 'active-assistant', state: 'running' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: 'prior-failed-invocation', turnId: 'prior-failed-turn', sequence: 1, schemaVersion: 1, eventId: 'prior-failed-1', idempotencyKey: 'prior-failed-i1', kind: 'invocation-context-committed', payload: { messages: [] } },
        { invocationId: 'prior-failed-invocation', turnId: 'prior-failed-turn', sequence: 2, schemaVersion: 1, eventId: 'prior-failed-2', idempotencyKey: 'prior-failed-i2', kind: 'invocation-failed', payload: { status: 'failed', message: 'prior failure' } }
      ], 0)
      await history.appendBatch([
        { invocationId: 'active-invocation', turnId: 'active-turn', sequence: 1, schemaVersion: 1, eventId: 'active-1', idempotencyKey: 'active-i1', kind: 'invocation-context-committed', payload: { messages: [] } },
        { invocationId: 'active-invocation', turnId: 'active-turn', sequence: 2, schemaVersion: 1, eventId: 'active-2', idempotencyKey: 'active-i2', kind: 'model-request-started', payload: { model: 'test-model' } }
      ], 0)
      const startTurn = vi.fn()
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [{ turnId: 'active-turn', sessionId: session.id }] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn, newRequestId: () => 'generated', audit: () => undefined
      })
      const requestId = 'running-continuation'
      const attachments = [{ id: 'running-image', name: 'proof.png', mimeType: 'image/png' } as never]
      expect(history.listInvocationIdsForSession(session.id).at(-1)).toBe('active-invocation')
      const accepted = await acceptor.submitOutbound({ sessionId: session.id, text: '继续', requestId, contextIntent: { kind: 'create-user', text: '继续', attachments } })
      expect(accepted).toMatchObject({ accepted: 'queued', queued: { requestId } })
      const queued = getNextQueuedMessage(temp.db, session.id)!
      expect(queued.message.content).toBe('继续')
      expect(queued.message.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'running-image' })]))
      expect(getDbConnection(temp.db).prepare('SELECT route,status,source_invocation_id,continuation_context_json FROM continuation_intents WHERE request_id=?').get(requestId)).toMatchObject({ route: 'ordinary-queue', status: 'queued', source_invocation_id: null, continuation_context_json: null })
      expect(history.readSync('active-invocation').events.at(-1)?.kind).toBe('model-request-started')
      claimQueuedTurnAtomically(temp.db, { sessionId: session.id, userMessageId: queued.message.id, turnId: 'drained-turn', assistantMessageId: 'drained-assistant', requestId })
      expect(getPersistedTurn(temp.db, 'drained-turn')?.executionConfig?.continuationContext).toBeUndefined()
      expect(startTurn).not.toHaveBeenCalled()
    } finally { temp.cleanup() }
  })

  it('queues continuation with stable request id and attachments when the session becomes busy during start', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, createPersistedTurn, getDbConnection, getNextQueuedMessage } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-start-race-')
    try {
      const session = createSession(temp.db, { name: 'start-race' })
      appendMessage(temp.db, { id: 'race-source-assistant', sessionId: session.id, role: 'assistant', content: 'failed source', timestamp: 1, status: 'failed' })
      createPersistedTurn(temp.db, { turnId: 'race-source-turn', requestId: 'race-source-invocation', sessionId: session.id, assistantMessageId: 'race-source-assistant', state: 'terminal', outcome: 'failed' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: 'race-source-invocation', turnId: 'race-source-turn', sequence: 1, schemaVersion: 1, eventId: 'race-source-1', idempotencyKey: 'race-source-i1', kind: 'invocation-context-committed', payload: { messages: [], requiredUserMessage: { id: 'race-prior-user', message: { role: 'user', content: 'check the files' } } } },
        { invocationId: 'race-source-invocation', turnId: 'race-source-turn', sequence: 2, schemaVersion: 1, eventId: 'race-source-2', idempotencyKey: 'race-source-i2', kind: 'invocation-failed', payload: { status: 'failed', message: 'failed after partial work' } }
      ], 0)
      const startTurn = vi.fn(async () => {
        throw new Error('SESSION_TURN_BUSY')
      })
      const notifyEnqueued = vi.fn()
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn, notifyEnqueued, newRequestId: () => 'generated', audit: () => undefined
      })
      const requestId = 'race-continuation-request'
      const attachments = [{ id: 'race-image', name: 'proof.png', mimeType: 'image/png' } as never]
      const accepted = await acceptor.submitOutbound({ sessionId: session.id, text: '继续检查', requestId, contextIntent: { kind: 'create-user', text: '继续检查', attachments } })
      expect(accepted).toMatchObject({ accepted: 'queued', queued: { requestId } })
      expect(startTurn).toHaveBeenCalledTimes(1)
      expect(notifyEnqueued).toHaveBeenCalledWith(session.id)
      const queued = getNextQueuedMessage(temp.db, session.id)!
      expect(queued.message.content).toBe('继续检查')
      expect(queued.message.attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'race-image' })]))
      expect(getDbConnection(temp.db).prepare('SELECT route,status,source_invocation_id,source_turn_id,continuation_context_json FROM continuation_intents WHERE request_id=?').get(requestId)).toMatchObject({
        route: 'context-queue', status: 'queued', source_invocation_id: 'race-source-invocation', source_turn_id: 'race-source-turn'
      })
      expect(history.listInvocationIdsForSession(session.id)).toContain('race-source-invocation')
    } finally { temp.cleanup() }
  })

  it('does not start a fallback Turn when checkpoint acceptance commit is uncertain', async () => {
    const { createTempDatabase } = await import('../database/testHelpers')
    const { createSession, appendMessage, createPersistedTurn, getDbConnection } = await import('../database')
    const { SqliteAgentHistory } = await import('../runtime/sqliteAgentHistory')
    const temp = createTempDatabase('sa-continuation-commit-uncertain-')
    try {
      const session = createSession(temp.db, { name: 'commit-uncertain' })
      appendMessage(temp.db, { id: 'uncertain-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 1, status: 'failed' })
      createPersistedTurn(temp.db, { turnId: 'uncertain-turn', requestId: 'uncertain-source', sessionId: session.id, assistantMessageId: 'uncertain-assistant', state: 'terminal', outcome: 'failed' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
      await history.appendBatch([
        { invocationId: 'uncertain-source', turnId: 'uncertain-turn', sequence: 1, schemaVersion: 1, eventId: 'uncertain-1', idempotencyKey: 'uncertain-i1', kind: 'invocation-context-committed', payload: { messages: [] } },
        { invocationId: 'uncertain-source', turnId: 'uncertain-turn', sequence: 2, schemaVersion: 1, eventId: 'uncertain-2', idempotencyKey: 'uncertain-i2', kind: 'invocation-failed', payload: { status: 'failed', message: 'source failed' } }
      ], 0)
      const startTurn = vi.fn()
      const acceptor = createOutboundAcceptor({
        db: temp.db, turnRuntime: { listActive: () => [] }, isDev: () => true, apiKeyPresent: () => true, getMaxParallel: () => 3, maxQueueSize: 10,
        readWikiConfig: () => ({ ...DEFAULT_WIKI_CONFIG, enabled: true }), listSkills: async () => [], getSkill: async () => null,
        wikiInit: async () => ({ ok: true as const, rootPath: '', skillInstalled: true }), wikiStatus: async () => ({ enabled: true, rootPath: '', initialized: true, pageCount: 0, rawCount: 0 }),
        wikiImportRaw: async ({ srcRelPath }) => ({ ok: true as const, rawRelPath: srcRelPath, copied: false }), appendHintMessage: () => undefined, updateSessionState: () => undefined,
        createSession: () => session, ensureSessionWorkDir: async () => ({ ok: true as const }), startTurn, startContinuation: async () => { throw new TransactionCommitUnknownError(new Error('injected')) },
        newRequestId: () => 'gen', audit: () => undefined
      })
      expect(await acceptor.submitOutbound({ sessionId: session.id, text: '继续', requestId: 'uncertain-request' })).toMatchObject({ rejected: { reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' } })
      expect(startTurn).not.toHaveBeenCalled()
    } finally { temp.cleanup() }
  })
})
