import type { Message, SessionSkillsState, SkillDefinition, WikiConfig, WikiStatus } from '../../src/shared/domainTypes'
import { normalizeSessionSkillsState } from '../../src/shared/domainTypes'
import { MAX_CHAT_MESSAGE_QUEUE_SIZE, countQueuedUserMessages } from '../../src/shared/chatMessageQueue'
import type { OutboundSessionPrefs, OutboundSubmitIntent, OutboundSubmitResult } from '../../src/shared/outboundProtocol'
import { getCallAdmissionGate, type CallAdmissionGate } from '../runtime/callAdmissionGate'
import type { TurnIntent } from '../../src/shared/assistantFactAggregator'
import { parseTestPopCommand } from '../../src/shared/outbound/testPopCommandService'
import { parseTestCardsCommand } from '../../src/shared/outbound/testCardsCommandService'
import { parseWikiCommand } from '../../src/shared/outbound/wikiCommandService'
import { parseSkillCommand } from '../../src/shared/outbound/skillCommandService'
import { patchSessionWikiState } from '../../src/shared/wikiSessionState'
import {
  computeEstimatedOccupancy,
  estimateThinkingTokensFromMessage,
  estimateTokensFromHistoryImages,
  estimateTokensFromImageAttachments,
  resolveEffectiveMaximumContext
} from '../../src/shared/contextUsageEstimate'
import { getSession, getSessionUsage, enqueueQueuedUserMessage, type AppDatabase } from '../database'
import { appendMessage, getMessages, getTurnByRequestId } from '../database'
import { getMessageSkeletons } from '../database/operations'
import { readStoredModels } from '../llmServiceResolver'
import { createHash } from 'node:crypto'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { getDbConnection } from '../database'
import { runInTransaction, TransactionCommitUnknownError } from '../database/transaction'
import { AgentContinuationRejectedError, startAgentContinuation } from '../runtime/agentContinuation'
import { createContinuationStartedSystemMessage } from '../../src/shared/skillHintRecords'

/** 出站受理时的主进程状态快照（全部由主进程权威源构建，渲染端不再提供其中任何一项） */
export type OutboundSnapshot = {
  isDev: boolean
  sessionExists: boolean
  sessionRunning: boolean
  activeTurnCount: number
  maxParallel: number
  apiKeyPresent: boolean
  queuedCount: number
  maxQueueSize: number
  wikiConfig: WikiConfig
  sessionSkillsState: SessionSkillsState
}

export type OutboundDecision =
  | { action: 'local-command'; command: Extract<OutboundSubmitResult, { accepted: 'local-command' }>['command'] }
  | { action: 'hint-only'; hint: string; skillsState?: SessionSkillsState }
  | { action: 'reject'; reason: string }
  | { action: 'enqueue'; text: string }
  | {
      action: 'start-turn'
      text: string
      skillsState?: SessionSkillsState
      wikiModeActive?: boolean
      /** B3:wiki run 等「先提示后发起」的用户反馈,随发起落库(main 语义保持) */
      hint?: string
      continuationIntent?: { kind: 'exact-continue' | 'follow-up' }
    }

/** 出站分类所需的 IO 端口（主进程直连实现由接线层注入；测试注入 fake） */
export type OutboundClassifierIo = {
  listSkills: () => Promise<SkillDefinition[]>
  getSkill: (payload: { name: string }) => Promise<SkillDefinition | null>
  wikiInit: (payload?: {
    overwrite?: boolean
    installSkill?: boolean
  }) => Promise<{ ok: true; rootPath: string; skillInstalled: boolean } | { ok: false; error: string }>
  wikiStatus: () => Promise<WikiStatus>
  wikiImportRaw: (payload: {
    srcRelPath: string
  }) => Promise<{ ok: true; rawRelPath: string; copied: boolean } | { ok: false; error: string }>
}

/**
 * 出站决定纯函数：从 ChatView.sendInternal / send 搬回主进程的决定序列。
 * 顺序对齐渲染端既有语义：test-pop（无需会话）→ 会话存在 → 并发守卫 → test-cards →
 * apiKey → wiki → skill → 运行中则排队 / 否则发起。
 */
export async function decideOutbound(
  intent: OutboundSubmitIntent,
  snapshot: OutboundSnapshot,
  io: OutboundClassifierIo
): Promise<OutboundDecision> {
  const trimmed = intent.text.trim()
  const exactContinue = ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(trimmed)
  const continuationIntent = exactContinue
    ? { kind: 'exact-continue' as const }
    : /^(继续|接着|刚才|上次)/u.test(trimmed)
      ? { kind: 'follow-up' as const }
      : undefined

  // ① test-pop：无需 API key、会话或配置（渲染端同序）
  const testPopCmd = parseTestPopCommand(trimmed, { isDev: snapshot.isDev })
  if (testPopCmd.type === 'command') return { action: 'hint-only', hint: testPopCmd.hint }
  if (testPopCmd.type === 'run') return { action: 'local-command', command: { kind: 'test-pop-run' } }

  // ② 会话存在性（无会话时创建是受理端口实现层的前置动作，此处兜底拒绝）
  if (!snapshot.sessionExists) return { action: 'reject', reason: 'OUTBOUND_SESSION_NOT_FOUND' }

  // ②.5 运行中会话不接受 reuse-user 发起（排水/重试）：与渲染端既有运行守卫同语义，
  // 排水器在触发前已检查 listActive，此处的拒绝属于竞态兜底（如 prepare 的 SESSION_TURN_BUSY 之前的早失败）
  if (snapshot.sessionRunning && intent.contextIntent?.kind === 'reuse-user') {
    return { action: 'reject', reason: 'OUTBOUND_SESSION_RUNNING' }
  }

  // ③ 并发守卫：仅约束「发起新 turn」；运行中会话的普通文本走排队而非拒绝
  const sessionRunning = snapshot.sessionRunning
  if (!sessionRunning && snapshot.activeTurnCount >= snapshot.maxParallel) {
    return { action: 'reject', reason: 'OUTBOUND_MAX_PARALLEL_REACHED' }
  }

  // ④ test-cards：开发模式 run 是渲染端本地预览；运行中则排队
  const testCardsCmd = parseTestCardsCommand(trimmed, { isDev: snapshot.isDev })
  if (testCardsCmd.type === 'command') return { action: 'hint-only', hint: testCardsCmd.hint }
  if (testCardsCmd.type === 'run') {
    if (sessionRunning) {
      if (snapshot.queuedCount >= snapshot.maxQueueSize) {
        return { action: 'reject', reason: 'OUTBOUND_QUEUE_FULL' }
      }
      return { action: 'enqueue', text: intent.text }
    }
    return { action: 'local-command', command: { kind: 'test-cards-run' } }
  }

  // ⑤ apiKey 守卫
  if (!snapshot.apiKeyPresent) return { action: 'reject', reason: 'OUTBOUND_API_KEY_MISSING' }

  let chatText = trimmed
  let skillsState = snapshot.sessionSkillsState
  let wikiModeActive = false

  // ⑥ wiki：command → 提示（skillsState 变更随受理事务落库）；run → 改写文本并激活 wiki 模式
  const wikiCmd = await parseWikiCommand(trimmed, snapshot.wikiConfig, skillsState, {
    wikiInit: io.wikiInit,
    wikiStatus: io.wikiStatus,
    wikiImportRaw: io.wikiImportRaw
  })
  if (wikiCmd.type === 'command') {
    return { action: 'hint-only', hint: wikiCmd.hint, ...(wikiCmd.skillsState ? { skillsState: wikiCmd.skillsState } : {}) }
  }
  let pendingHint: string | undefined
  if (wikiCmd.type === 'run') {
    chatText = wikiCmd.text
    skillsState = wikiCmd.skillsState
    wikiModeActive = true
    pendingHint = wikiCmd.hint
  }

  // ⑦ skill：command → 提示
  const skillCmd = await parseSkillCommand(chatText, skillsState, {
    listSkills: io.listSkills,
    getSkill: io.getSkill
  })
  if (skillCmd.type === 'command') {
    return { action: 'hint-only', hint: skillCmd.hint, ...(skillCmd.skillsState ? { skillsState: skillCmd.skillsState } : {}) }
  }

  // ⑧ 运行中且非 reuse-user（排水/重试）→ 排队；否则发起
  if (sessionRunning && intent.contextIntent?.kind !== 'reuse-user') {
    if (snapshot.queuedCount >= snapshot.maxQueueSize) {
      return { action: 'reject', reason: 'OUTBOUND_QUEUE_FULL' }
    }
    return { action: 'enqueue', text: intent.text }
  }

  return {
    action: 'start-turn',
    text: chatText,
    ...(continuationIntent ? { continuationIntent } : {}),
    ...(skillsState !== snapshot.sessionSkillsState ? { skillsState } : {}),
    ...(wikiModeActive ? { wikiModeActive: true } : {}),
    ...(pendingHint ? { hint: pendingHint } : {})
  }
}

export type OutboundTurnStarter = (input: {
  turnIntent: TurnIntent
}) => Promise<{ turnId: string; assistantMessage: Message; warnings?: string[] }>

export type OutboundAcceptorDeps = {
  db: AppDatabase
  turnRuntime: { listActive(sessionId?: string): Array<{ turnId: string; sessionId: string }> }
  isDev: () => boolean
  apiKeyPresent: () => boolean
  getMaxParallel: () => number
  maxQueueSize?: number
  readWikiConfig: () => WikiConfig
  listSkills: () => Promise<SkillDefinition[]>
  getSkill: (payload: { name: string }) => Promise<SkillDefinition | null>
  wikiInit: (payload?: {
    overwrite?: boolean
    installSkill?: boolean
  }) => Promise<{ ok: true; rootPath: string; skillInstalled: boolean } | { ok: false; error: string }>
  wikiStatus: () => Promise<WikiStatus>
  wikiImportRaw: (payload: {
    srcRelPath: string
  }) => Promise<{ ok: true; rawRelPath: string; copied: boolean } | { ok: false; error: string }>
  appendHintMessage: (sessionId: string, hint: string) => Promise<{ messageId: string; sequence: number } | void> | { messageId: string; sequence: number } | void
  updateSessionState: (
    sessionId: string,
    patch: { skillsState?: SessionSkillsState; metadataPatch?: Record<string, unknown> }
  ) => Promise<void> | void
  createSession: (
    prefs?: OutboundSessionPrefs
  ) => Promise<Pick<Session_Requested, 'id'>> | Pick<Session_Requested, 'id'>
  /** B2(v2 评审):发起/排队前按会话绑定 profile 对齐主进程 active workDir(main 语义回收) */
  ensureSessionWorkDir: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>
  /** B3(v2 评审):enqueue 落库后通知(受理端口不持有排水器,由接线层把 drain 接进来),闭环 snapshot→enqueue 窗口竞态 */
  notifyEnqueued?: (sessionId: string) => void
  startTurn: OutboundTurnStarter
  startContinuation?: (input: { sessionId: string; sourceInvocationId: string; requestId: string; continuationAcceptance: { payloadSha256: string; rawText: string; attachments?: NonNullable<Message['attachments']>; intentKind: 'exact-continue' | 'follow-up'; route: string } }) => Promise<{ continuationId: string; targetTurnId: string; status: string }>
  findRetrySource?: (input: { sessionId: string; text: string; attachments?: Message['attachments']; requestId: string }) => Promise<{ assistantMessageId: string; sourceInvocationId: string } | undefined>
  /** 占用 ≥80% 通过型警告（P2-2）：返回错误码数组，随 turn-started.warnings 透出 */
  contextUsageWarn?: (input: { sessionId: string; model: string; attachments?: Message['attachments'] }) => Promise<string[]>
  newRequestId: () => string
  audit: (event: string, data: Record<string, unknown>) => void
  /** B1(偏差 23):调用级准入门;缺省全局默认门(db 装配由 main.ts 持有)。 */
  admissionGate?: AdmissionGate
}

/** 仅取 id 的会话形（避免拉入完整 Session 类型依赖） */
type Session_Requested = { id: string }

/** 准入门最小面(偏差 23):便于测试注入;与 CallAdmissionGate.acquire 同形。 */
export type AdmissionGate = Pick<CallAdmissionGate, 'acquire'>

/** Only structured canonical History events can produce claims about completed side effects. */
export function summarizeFailedInvocation(snapshot: ReturnType<SqliteAgentHistory['readSync']>, invocationId: string, turnId: string) {
  const events = snapshot.events
  const committed = events.filter((event) => event.kind === 'tool-call-finished')
  const proposals = new Map<string, { toolName?: string; input?: Record<string, unknown> }>()
  for (const event of events.filter((candidate) => candidate.kind === 'model-response-committed')) {
    const payload = event.payload as { message?: { toolCalls?: Array<{ id?: string; name?: string; toolName?: string; input?: Record<string, unknown> }> }; toolCalls?: Array<{ id?: string; name?: string; toolName?: string; input?: Record<string, unknown> }> }
    for (const call of payload.message?.toolCalls ?? payload.toolCalls ?? []) {
      const id = call.id
      if (id) proposals.set(id, { toolName: call.toolName ?? call.name, input: call.input })
    }
  }
  const started = new Map(events.filter((event) => event.kind === 'tool-call-started').map((event) => {
    const payload = event.payload as { toolCallId?: unknown; toolName?: string }
    const id = String(payload.toolCallId ?? '')
    return [id, { toolName: payload.toolName, ...proposals.get(id) }] as const
  }))
  const settled = new Set(committed.map((event) => String((event.payload as { toolCallId?: unknown }).toolCallId ?? '')))
  const successful: string[] = []
  const failed: string[] = []
  for (const event of committed) {
    const payload = event.payload as { toolCallId?: string; result?: unknown; toolName?: string; name?: string; input?: Record<string, unknown>; success?: boolean; isError?: boolean }
    const result = payload.result && typeof payload.result === 'object' ? payload.result as Record<string, unknown> : {}
    const proposal = started.get(String(payload.toolCallId ?? ''))
    const toolName = String(payload.toolName ?? payload.name ?? proposal?.toolName ?? 'tool')
    const input = payload.input ?? proposal?.input
    const target = String(input?.path ?? input?.filePath ?? '')
    const ok = payload.success === true && payload.isError !== true
    const line = `history#${event.sequence} ${toolName}${target ? ` ${target}` : ''}: ${JSON.stringify(result).slice(0, 350)}`
    ;(ok ? successful : failed).push(line)
  }
  const unsettled = [...started].filter(([id]) => id && !settled.has(id))
  const unknownStarted = unsettled.length > 0
  const terminal = events.at(-1)
  const terminalPayload = terminal?.payload && typeof terminal.payload === 'object' ? terminal.payload as Record<string, unknown> : {}
  const target = unsettled.at(-1)?.[1]
  const lines = [
    `Source invocation ${invocationId}, turn ${turnId}; canonical History through sequence ${events.at(-1)?.sequence ?? 0}.`,
    `Original task: ${String((events[0]?.payload as { requiredUserMessage?: { message?: { content?: unknown } } } | undefined)?.requiredUserMessage?.message?.content ?? '(task text not available)')}`,
    `Committed successful tool results: ${successful.length ? successful.join('\n') : 'none proven.'}`,
    `Failed tool results: ${failed.length ? failed.join('\n') : 'none recorded.'}`,
    `Final failure: ${String(terminalPayload.message ?? terminalPayload.error ?? terminalPayload.reason ?? 'Invocation failed.')}`,
    unknownStarted ? `Side-effect state unknown for dispatched operation ${target?.toolName ?? 'tool'} ${String(target?.input?.path ?? target?.input?.filePath ?? '')}.` : 'No dispatched-but-unsettled tool call found.',
    'These are historical facts, not instructions to replay tools. Read current targets and compare with the recorded successful changes before editing; report differences instead of assuming an external change.'
  ]
  const summary = lines.join('\n').slice(0, 6000)
  return { sourceInvocationId: invocationId, sourceTurnId: turnId, historySequence: events.at(-1)?.sequence ?? 0, summary, state: unknownStarted ? 'unknown' as const : 'known' as const }
}

export function createOutboundAcceptor(deps: OutboundAcceptorDeps) {
  const intentInFlight = new Map<string, string>()
  const io: OutboundClassifierIo = {
    listSkills: deps.listSkills,
    getSkill: deps.getSkill,
    wikiInit: deps.wikiInit,
    wikiStatus: deps.wikiStatus,
    wikiImportRaw: deps.wikiImportRaw
  }

  const countQueued = (sessionId: string): number => countQueuedUserMessages(getMessageSkeletons(deps.db, sessionId), sessionId)

  function ensureContinuationStatusMessage(sessionId: string, requestId: string): { messageId: string; sequence: number } {
    const conn = getDbConnection(deps.db)
    const messageId = `continuation-status-${createHash('sha256').update(`${sessionId}\0${requestId}`).digest('hex')}`
    const existing = conn.prepare('SELECT sequence FROM messages WHERE session_id=? AND id=?').get(sessionId, messageId) as { sequence?: number } | undefined
    if (existing?.sequence != null) return { messageId, sequence: existing.sequence }
    const persisted = appendMessage(deps.db, createContinuationStartedSystemMessage(sessionId, messageId))
    return { messageId, sequence: persisted.sequence }
  }

  /** 排队落库（v2-B4 降级与 enqueue 决定共用）：幂等凭证、附件兜底、落库后补触发（v2-B3） */
  function enqueueDecision(
    sessionId: string,
    text: string,
    intent: OutboundSubmitIntent,
    notify = true
  ): Extract<OutboundSubmitResult, { accepted: 'queued' }> {
    // 幂等凭证：reuse-user（排水）透传原 requestId，否则新生成
    const generatedRequestId =
      intent.contextIntent?.kind === 'reuse-user' && intent.contextIntent.requestId
        ? intent.contextIntent.requestId
        : deps.newRequestId()
    const requestId = intent.requestId ?? generatedRequestId
    const enqueued = enqueueQueuedUserMessage(deps.db, {
      sessionId,
      requestId,
      content: text,
      // 附件兜底：渲染端把附件放在 contextIntent.create-user.attachments，排队路径同样带上
      attachments: intent.attachments ?? (intent.contextIntent?.kind === 'create-user' ? intent.contextIntent.attachments : undefined)
    })
    if (notify) deps.notifyEnqueued?.(sessionId)
    return {
      accepted: 'queued',
      sessionId,
      queued: { requestId, messageId: enqueued.persisted.message.id, sequence: enqueued.persisted.sequence }
    }
  }

  async function submitOutbound(rawIntent: OutboundSubmitIntent): Promise<OutboundSubmitResult> {
    const intent: OutboundSubmitIntent = {
      ...rawIntent,
      attachments: rawIntent.attachments?.length ? rawIntent.attachments : (rawIntent.contextIntent?.kind === 'create-user' ? rawIntent.contextIntent.attachments : undefined)
    }
    let routedContinuationSource: { invocationId: string; turnId: string; sequence: number; summary: string; state: 'known' | 'unknown' } | undefined
    let continuationRouting = false
    const queueContinuation = (sessionId: string, text: string) => {
      const conn = getDbConnection(deps.db)
      const queued = runInTransaction(conn, () => {
        const accepted = enqueueDecision(sessionId, text, intent, false)
        const context = routedContinuationSource ? { sourceInvocationId: routedContinuationSource.invocationId, sourceTurnId: routedContinuationSource.turnId, historySequence: routedContinuationSource.sequence, summary: routedContinuationSource.summary, state: routedContinuationSource.state } : undefined
        conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,target_id,status,continuation_context_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET route=excluded.route,source_invocation_id=excluded.source_invocation_id,source_turn_id=excluded.source_turn_id,source_sequence=excluded.source_sequence,target_id=excluded.target_id,status=excluded.status,continuation_context_json=excluded.continuation_context_json,updated_at=excluded.updated_at`)
          .run(intent.requestId!, sessionId, createHash('sha256').update(JSON.stringify({ sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex'), intent.text, JSON.stringify(intent.attachments ?? []), ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length ? 'exact-continue' : 'follow-up', routedContinuationSource ? 'context-queue' : 'ordinary-queue', routedContinuationSource?.invocationId ?? null, routedContinuationSource?.turnId ?? null, routedContinuationSource?.sequence ?? null, accepted.queued.messageId, 'queued', context ? JSON.stringify(context) : null, Date.now(), Date.now())
        return accepted
      })
      deps.notifyEnqueued?.(sessionId)
      return queued
    }
    if (intent.requestId && intent.sessionId && /^(继续|继续执行|接着做|接着刚才的修改|继续上次的任务|接着|刚才|上次)/u.test(intent.text.trim())) {
      continuationRouting = true
      const fingerprint = createHash('sha256').update(JSON.stringify({ sessionId: intent.sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex')
      const prior = getDbConnection(deps.db).prepare('SELECT * FROM continuation_intents WHERE request_id=?').get(intent.requestId) as Record<string, unknown> | undefined
      if (prior) {
        if (prior.payload_sha256 !== fingerprint) return { rejected: { reason: 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT' } }
        const status = String(prior.status)
        const target = prior.target_id ? String(prior.target_id) : undefined
        if (status === 'needs_source_selection' && !intent.sourceSelection) return { rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } }
        if (status === 'needs_source_selection' && intent.sourceSelection?.asOrdinaryTurn) {
          // Explicit ordinary fallback is finalized under this request ID below.
          getDbConnection(deps.db).prepare('UPDATE continuation_intents SET status=?,route=?,updated_at=? WHERE request_id=?')
            .run('ordinary_fallback_pending', 'ordinary-selected', Date.now(), intent.requestId)
        }
        if (status === 'accepted_continuation' && target) {
          const statusReceipt = runInTransaction(getDbConnection(deps.db), () => ensureContinuationStatusMessage(intent.sessionId!, intent.requestId!))
          return { accepted: 'local-command', sessionId: intent.sessionId, command: { kind: 'continuation-started', ...statusReceipt } }
        }
        if (status === 'queued' && target) {
          const message = getMessages(deps.db, intent.sessionId).find((candidate) => candidate.id === target)
          const sequence = message && getDbConnection(deps.db).prepare('SELECT sequence FROM messages WHERE session_id=? AND id=?').get(intent.sessionId, target) as { sequence?: number } | undefined
          if (!message || sequence?.sequence == null || message.status !== 'queued') return { rejected: { reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' } }
          return { accepted: 'queued', sessionId: intent.sessionId, queued: { requestId: intent.requestId, messageId: target, sequence: sequence.sequence } }
        }
          if (status === 'accepted_turn' && target) {
            const turn = getTurnByRequestId(deps.db, intent.sessionId, intent.requestId)
            if (turn) return { accepted: 'turn-started', sessionId: turn.sessionId, turnId: turn.turnId, assistantMessage: getMessages(deps.db, turn.sessionId).find((message) => message.id === turn.assistantMessageId)! }
            return { rejected: { reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' } }
          }
        if (status === 'rejected_retryable' || status === 'commit_uncertain') return { rejected: { reason: String(prior.rejection_reason ?? status) } }
      }
      const locked = intentInFlight.get(intent.requestId)
      if (locked && locked !== fingerprint) return { rejected: { reason: 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT' } }
      if (locked) return { rejected: { reason: 'CONTINUATION_INTENT_IN_PROGRESS' } }
      intentInFlight.set(intent.requestId, fingerprint)
      try {
        const conn = getDbConnection(deps.db)
        const now = Date.now()
        const exact = ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length
        const history = new SqliteAgentHistory(conn, 1, Date.now, intent.sessionId)
        const activeTurnIds = new Set(deps.turnRuntime.listActive(intent.sessionId).map((turn) => turn.turnId))
        const allInvocationIds = history.listInvocationIdsForSession(intent.sessionId)
        const latestInvocation = allInvocationIds.length ? history.readSync(allInvocationIds.at(-1)!) : undefined
        const latestEvent = latestInvocation?.events.at(-1)
        // 最新非终态 History 与活动 Turn 相对应，说明较新的任务已越过旧失败边界。
        // 输入应先进入排队判断，并作为普通新输入处理，不能要求该 History 已终结。
        const supersededByRunningTurn = Boolean(latestEvent && !['invocation-completed', 'invocation-failed'].includes(latestEvent.kind) && activeTurnIds.has(latestEvent.turnId))
        const invocationIds = supersededByRunningTurn ? [] : allInvocationIds
        if (latestEvent && !supersededByRunningTurn && !['invocation-completed', 'invocation-failed'].includes(latestEvent.kind)) {
          const latest = history.readSync(invocationIds.at(-1)!)
          if (!['invocation-completed', 'invocation-failed'].includes(latest.events.at(-1)?.kind ?? '')) {
            throw new Error('CONTINUATION_INTENT_HISTORY_UNAVAILABLE')
          }
        }
        let source: { invocationId: string; turnId: string; snapshot: ReturnType<SqliteAgentHistory['readSync']> } | undefined
        const failedCandidates: Array<{ invocationId: string; turnId: string; snapshot: ReturnType<SqliteAgentHistory['readSync']> }> = []
        for (const invocationId of invocationIds.reverse()) {
          const snapshot = history.readSync(invocationId)
          const terminal = snapshot.events.at(-1)
          if (terminal?.kind === 'invocation-failed') {
            const sourceMessage = conn.prepare(`SELECT m.sequence FROM turns t JOIN messages m ON m.id=t.assistant_message_id WHERE t.session_id=? AND t.turn_id=?`).get(intent.sessionId, terminal.turnId) as { sequence?: number } | undefined
            const newerAcceptedInput = sourceMessage?.sequence == null ? undefined : conn.prepare(`SELECT id FROM messages WHERE session_id=? AND role='user' AND sequence>? AND status IN ('sent','queued') ORDER BY sequence ASC LIMIT 1`).get(intent.sessionId, sourceMessage.sequence)
            if (newerAcceptedInput) break
            failedCandidates.push({ invocationId, turnId: terminal.turnId, snapshot })
            continue
          }
          if (terminal?.kind === 'invocation-completed') break
        }
        if (failedCandidates.length === 1) source = failedCandidates[0]
        if (failedCandidates.length > 1 && intent.sourceSelection?.chooseLatest) source = failedCandidates[0]
        if (failedCandidates.length > 1 && !intent.sourceSelection && !prior) {
          const dbNow = Date.now()
          runInTransaction(conn, () => conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(intent.requestId!, intent.sessionId!, fingerprint, intent.text, JSON.stringify(intent.attachments ?? []), exact ? 'exact-continue' : 'follow-up', 'needs-source-selection', 'needs_source_selection', dbNow, dbNow))
          return { rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } }
        }
        const insertIntent = (route: string, status: string, sourceInvocationId?: string, sourceTurnId?: string, sourceSequence?: number, targetId?: string, rejectionReason?: string) => runInTransaction(conn, () => {
          const exists = conn.prepare('SELECT payload_sha256 FROM continuation_intents WHERE request_id=?').get(intent.requestId!) as { payload_sha256: string } | undefined
          if (exists && exists.payload_sha256 !== fingerprint) throw new Error('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')
          conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,target_id,status,rejection_reason,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET route=excluded.route,status=excluded.status,target_id=excluded.target_id,rejection_reason=excluded.rejection_reason,updated_at=excluded.updated_at`)
            .run(intent.requestId!, intent.sessionId!, fingerprint, intent.text, JSON.stringify(intent.attachments ?? []), exact ? 'exact-continue' : 'follow-up', route, sourceInvocationId ?? null, sourceTurnId ?? null, sourceSequence ?? null, targetId ?? null, status, rejectionReason ?? null, now, now)
        })
        if (!source && failedCandidates.length > 1 && !intent.sourceSelection && !prior) {
          insertIntent('needs-source-selection', 'needs_source_selection')
          return { rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } }
        }
        const ordinarySourceOverride = !source && failedCandidates.length > 1 && intent.sourceSelection?.asOrdinaryTurn === true
        if (!source && intent.sourceSelection?.sourceAssistantMessageId) {
          const chosen = getMessages(deps.db, intent.sessionId).find((item) => item.id === intent.sourceSelection!.sourceAssistantMessageId)
          const chosenTurn = chosen && (conn.prepare('SELECT request_id AS requestId,turn_id AS turnId FROM turns WHERE session_id=? AND assistant_message_id=?').get(intent.sessionId, chosen.id) as { requestId?: string; turnId?: string } | undefined)
          const selected = chosenTurn && failedCandidates.find((candidate) => candidate.invocationId === chosenTurn.requestId || candidate.turnId === chosenTurn.turnId)
          if (!selected) return { rejected: { reason: 'CONTINUATION_SOURCE_NOT_FOUND' } }
          source = selected
        }
        if (!source && !ordinarySourceOverride && failedCandidates.length === 0) {
          if (intent.sourceSelection?.asOrdinaryTurn) {
            insertIntent('ordinary-selected', 'accepted_turn')
          } else if (intent.sourceSelection?.sourceAssistantMessageId) {
            const chosen = getMessages(deps.db, intent.sessionId).find((item) => item.id === intent.sourceSelection!.sourceAssistantMessageId)
            const chosenTurn = chosen && (conn.prepare('SELECT request_id AS requestId FROM turns WHERE session_id=? AND assistant_message_id=?').get(intent.sessionId, chosen.id) as { requestId?: string } | undefined)
            if (!chosen || !chosenTurn?.requestId) return { rejected: { reason: 'CONTINUATION_SOURCE_NOT_FOUND' } }
            const snapshot = history.readSync(chosenTurn.requestId)
            const terminal = snapshot.events.at(-1)
            if (terminal?.kind !== 'invocation-failed') return { rejected: { reason: 'CONTINUATION_SOURCE_NOT_RECOVERABLE' } }
            source = { invocationId: chosenTurn.requestId, turnId: terminal.turnId, snapshot }
          }
        }
        if (!source && failedCandidates.length === 0) {
          const recentUserRow = conn.prepare("SELECT id,sequence FROM messages WHERE session_id=? AND role='user' ORDER BY sequence DESC LIMIT 1").get(intent.sessionId) as { id: string; sequence: number } | undefined
          const relationCue = /^(继续|接着|刚才|上次)/u.test(intent.text.trim())
          if (recentUserRow && relationCue) {
            const intentRows = getMessages(deps.db, intent.sessionId).filter((message) => message.role === 'assistant' && message.status === 'failed')
            if (intentRows.length === 1) {
              const failedAssistantRow = conn.prepare('SELECT sequence FROM messages WHERE id=?').get(intentRows[0]!.id) as { sequence?: number } | undefined
              const failedTurn = getDbConnection(deps.db).prepare('SELECT request_id FROM turns WHERE assistant_message_id=?').get(intentRows[0]!.id) as { request_id?: string } | undefined
              // A newer accepted user message owns the latest task boundary. Never attach an older failure to it.
              if (failedTurn?.request_id && failedAssistantRow?.sequence != null && recentUserRow.sequence < failedAssistantRow.sequence) {
                const snapshot = history.readSync(failedTurn.request_id)
                const terminal = snapshot.events.at(-1)
                if (terminal?.kind === 'invocation-failed') {
                  const summary = summarizeFailedInvocation(snapshot, snapshot.invocationId, terminal.turnId)
                  routedContinuationSource = { invocationId: summary.sourceInvocationId, turnId: summary.sourceTurnId, sequence: summary.historySequence, summary: summary.summary, state: summary.state }
                }
              }
            }
          }
        }
        if (source && exact && !intent.attachments?.length && deps.startContinuation) {
          // Start the already validated source checkpoint from this same stable input request.
          let continuationStarted = false
          try {
            insertIntent('continuation', 'starting_continuation', source.invocationId, source.turnId, source.snapshot.events.at(-1)?.sequence)
            const started = await deps.startContinuation({ sessionId: intent.sessionId, sourceInvocationId: source.invocationId, requestId: intent.requestId, continuationAcceptance: { payloadSha256: fingerprint, rawText: intent.text, attachments: intent.attachments, intentKind: 'exact-continue', route: 'continuation' } })
            continuationStarted = true
            const statusReceipt = runInTransaction(conn, () => {
              insertIntent('continuation', 'accepted_continuation', source.invocationId, source.turnId, source.snapshot.events.at(-1)?.sequence, started.continuationId)
              return ensureContinuationStatusMessage(intent.sessionId!, intent.requestId!)
            })
            return { accepted: 'local-command', sessionId: intent.sessionId, command: { kind: 'continuation-started', ...statusReceipt } }
          } catch (error) {
            // Unsafe checkpoints become a context-only new Turn with the original text and attachments.
            if (error instanceof Error && error.message === 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT') throw error
            if (continuationStarted || error instanceof TransactionCommitUnknownError) return { rejected: { reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' } }
            if (error instanceof Error && error.message === 'CONTINUATION_SOURCE_STALE') {
              // Keep the input as an ordinary new Turn without inheriting an out-of-date failure.
            } else {
            const summary = summarizeFailedInvocation(source.snapshot, source.invocationId, source.turnId)
            routedContinuationSource = { invocationId: summary.sourceInvocationId, turnId: summary.sourceTurnId, sequence: summary.historySequence, summary: summary.summary, state: summary.state }
            }
          }
        } else if (source && !(exact && !intent.attachments?.length && deps.startContinuation)) {
          const summary = summarizeFailedInvocation(source.snapshot, source.invocationId, source.turnId)
          routedContinuationSource = { invocationId: summary.sourceInvocationId, turnId: summary.sourceTurnId, sequence: summary.historySequence, summary: summary.summary, state: summary.state }
        }
      } catch (error) {
        if (error instanceof TransactionCommitUnknownError) {
          return { rejected: { reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' } }
        }
        if (error instanceof Error && error.message === 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT') return { rejected: { reason: error.message } }
        return { rejected: { reason: error instanceof Error ? error.message : 'CONTINUATION_INTENT_REJECTED' } }
      } finally {
        intentInFlight.delete(intent.requestId)
      }
    }
    // 前置快路径：test-pop 不依赖会话 / apiKey（渲染端 sendInternal 同序）
    const testPopCmd = parseTestPopCommand(intent.text.trim(), { isDev: deps.isDev() })
    if (testPopCmd.type === 'run') {
      return { accepted: 'local-command', command: { kind: 'test-pop-run' } }
    }
    if (testPopCmd.type === 'command') {
      const sessionId = intent.sessionId
      if (sessionId && getSession(deps.db, sessionId)) {
        await deps.appendHintMessage(sessionId, testPopCmd.hint)
      }
      return { accepted: 'local-command', command: { kind: 'hint-only', hint: testPopCmd.hint } }
    }

    // B1(偏差 23):调用级准入——桌面受理端口(普通 Agent turn 入口之一)。
    // 受理级票据(瞬时)+ 全局速率约束;queue 语义由既有会话级出站排队承载,故此处声明 reject。
    const admissionGate = deps.admissionGate ?? getCallAdmissionGate()
      const admission = await admissionGate.acquire({
      lane: 'desktop',
      priority: 'interactive',
      role: 'top-level',
      disposition: 'reject',
      requestId: intent.requestId ?? deps.newRequestId()
    })
    if (!admission.ok) {
      if (admission.verdict === 'rejected') {
        deps.audit('outbound.submit.rejected', { reason: `ADMISSION_${admission.cause.toUpperCase()}` })
        return { rejected: { reason: `ADMISSION_${admission.cause.toUpperCase()}` } }
      }
      return { rejected: { reason: 'ADMISSION_THROTTLED' } }
    }
    try {
    // 会话解析/创建：无会话 = 请主进程创建（决定回主进程）
    let sessionId = intent.sessionId
    if (!sessionId) {
      const created = await deps.createSession(intent.sessionPrefs)
      sessionId = created.id
      deps.audit('outbound.session.created', { sessionId })
    } else if (!getSession(deps.db, sessionId)) {
      const reason = 'OUTBOUND_SESSION_NOT_FOUND'
      deps.audit('outbound.submit.rejected', { sessionId, reason })
      return { rejected: { reason } }
    }

    const session = getSession(deps.db, sessionId)
    const snapshot: OutboundSnapshot = {
      isDev: deps.isDev(),
      sessionExists: Boolean(session),
      sessionRunning: deps.turnRuntime.listActive(sessionId).length > 0,
      activeTurnCount: deps.turnRuntime.listActive().length,
      maxParallel: deps.getMaxParallel(),
      apiKeyPresent: deps.apiKeyPresent(),
      queuedCount: session ? countQueued(sessionId) : 0,
      maxQueueSize: deps.maxQueueSize ?? MAX_CHAT_MESSAGE_QUEUE_SIZE,
      wikiConfig: deps.readWikiConfig(),
      sessionSkillsState: normalizeSessionSkillsState(session?.skillsState)
    }

    const decision = await decideOutbound(intent, snapshot, io)

    switch (decision.action) {
      case 'local-command':
        return { accepted: 'local-command', command: decision.command, sessionId }
      case 'hint-only': {
        const persisted = await deps.appendHintMessage(sessionId, decision.hint)
        if (decision.skillsState) {
          await deps.updateSessionState(sessionId, { skillsState: decision.skillsState })
        }
        return {
          accepted: 'local-command',
          command: {
            kind: 'hint-only',
            hint: decision.hint,
            ...(persisted ? { messageId: persisted.messageId, sequence: persisted.sequence } : {})
          },
          sessionId
        }
      }
      case 'reject': {
        deps.audit('outbound.submit.rejected', { sessionId, reason: decision.reason })
        return { rejected: { reason: decision.reason } }
      }
      case 'enqueue': {
        if (continuationRouting && intent.requestId) {
          return queueContinuation(sessionId, decision.text)
        }
        return enqueueDecision(sessionId, decision.text, intent)
      }
      case 'start-turn': {
        // B2(v2 评审):发起前按会话绑定 profile 对齐 workDir(main ensureWorkDirForSession 语义回收)
        const wd = await deps.ensureSessionWorkDir(sessionId)
        if (!wd.ok) {
          deps.audit('outbound.submit.rejected', { sessionId, reason: 'OUTBOUND_WORKDIR_SWITCH_FAILED', detail: wd.error })
          return { rejected: { reason: 'OUTBOUND_WORKDIR_SWITCH_FAILED' } }
        }
        // wiki run 的「已开始」类提示随发起落库(main 语义保持)
        if (decision.hint) {
          await deps.appendHintMessage(sessionId, decision.hint)
        }
        if (decision.skillsState || decision.wikiModeActive) {
          await deps.updateSessionState(sessionId, {
            ...(decision.skillsState ? { skillsState: decision.skillsState } : {}),
            ...(decision.wikiModeActive
              ? { metadataPatch: patchSessionWikiState(session?.metadata, { wikiModeActive: true }) }
              : {})
          })
        }
        const contextIntent = intent.contextIntent
        const retrySource = continuationRouting && intent.requestId
          ? await deps.findRetrySource?.({ sessionId, text: intent.text, attachments: intent.attachments, requestId: intent.requestId })
          : undefined
        if (continuationRouting && intent.requestId) {
          const conn = getDbConnection(deps.db)
          let target: Awaited<ReturnType<typeof deps.startTurn>>
          try {
          target = await deps.startTurn({ turnIntent: contextIntent?.kind === 'reuse-user' ? {
            mode: 'reuse-user', requestId: intent.requestId, sessionId, userMessageId: contextIntent.currentUser.message.id,
            excludeMessageIds: contextIntent.excludeMessageIds ?? [], config: routedContinuationSource ? { continuationContext: { sourceInvocationId: routedContinuationSource.invocationId, sourceTurnId: routedContinuationSource.turnId, historySequence: routedContinuationSource.sequence, summary: routedContinuationSource.summary, state: routedContinuationSource.state } } : {}
          } : {
            mode: 'create-user', requestId: intent.requestId, sessionId,
            input: { text: decision.text, attachments: intent.attachments ?? (contextIntent?.kind === 'create-user' ? contextIntent.attachments : undefined) },
            config: routedContinuationSource ? { continuationContext: { sourceInvocationId: routedContinuationSource.invocationId, sourceTurnId: routedContinuationSource.turnId, historySequence: routedContinuationSource.sequence, summary: routedContinuationSource.summary, state: routedContinuationSource.state } } : {},
            continuationAcceptance: {
              payloadSha256: createHash('sha256').update(JSON.stringify({ sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex'),
              rawText: intent.text,
              kind: ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length ? 'exact-continue' : 'follow-up',
              route: routedContinuationSource ? 'context-turn' : 'ordinary',
              ...(routedContinuationSource ? { sourceInvocationId: routedContinuationSource.invocationId, sourceTurnId: routedContinuationSource.turnId, sourceSequence: routedContinuationSource.sequence } : {})
            },
            ...(retrySource ? { retryOfMessageId: retrySource.assistantMessageId, retryOfInvocationId: retrySource.sourceInvocationId } : {})
          } })
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.includes('SESSION_TURN_BUSY')) {
              deps.audit('outbound.submit.degraded_to_queue', { sessionId, requestId: intent.requestId })
              return queueContinuation(sessionId, decision.text)
            }
            deps.audit('outbound.submit.rejected', { sessionId, reason: msg, requestId: intent.requestId })
            return { rejected: { reason: msg } }
          }
          // Real TurnCoordinator commits this receipt atomically with prepareAtomic. The idempotent
          // upsert also repairs adapters that return an already persisted Turn without that hook.
          conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,target_id,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET target_id=excluded.target_id,status=excluded.status,updated_at=excluded.updated_at`)
            .run(intent.requestId, sessionId, createHash('sha256').update(JSON.stringify({ sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex'), intent.text, JSON.stringify(intent.attachments ?? []), ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length ? 'exact-continue' : 'follow-up', routedContinuationSource ? 'context-turn' : 'ordinary', routedContinuationSource?.invocationId ?? null, routedContinuationSource?.turnId ?? null, routedContinuationSource?.sequence ?? null, target.turnId, 'accepted_turn', Date.now(), Date.now())
          if (retrySource) conn.prepare('UPDATE turns SET retry_of_message_id=?,retry_of_invocation_id=? WHERE turn_id=?')
            .run(retrySource.assistantMessageId, retrySource.sourceInvocationId, target.turnId)
          return { accepted: 'turn-started', sessionId, turnId: target.turnId, assistantMessage: target.assistantMessage }
        }
        const turnIntent: TurnIntent =
          contextIntent?.kind === 'reuse-user'
            ? {
                mode: 'reuse-user',
                requestId: contextIntent.requestId ?? deps.newRequestId(),
                sessionId,
                userMessageId: contextIntent.currentUser.message.id,
                excludeMessageIds: contextIntent.excludeMessageIds ?? [],
                config: {}
              }
              : {
                mode: 'create-user',
                requestId: intent.requestId ?? deps.newRequestId(),
                sessionId,
                input: {
                  text: decision.text,
                  attachments: intent.attachments ?? (contextIntent?.kind === 'create-user' ? contextIntent.attachments : undefined)
                },
                config: routedContinuationSource ? { continuationContext: { sourceInvocationId: routedContinuationSource.invocationId, sourceTurnId: routedContinuationSource.turnId, historySequence: routedContinuationSource.sequence, summary: routedContinuationSource.summary, state: routedContinuationSource.state } } : {},
                ...(decision.continuationIntent ? { continuationIntent: { ...decision.continuationIntent, ...(intent.requestId ? { requestId: intent.requestId } : {}) } } : {})
              }
        try {
        const started = await deps.startTurn({ turnIntent })
        if (continuationRouting && intent.requestId) {
          getDbConnection(deps.db).prepare("UPDATE continuation_intents SET target_id=?,status='accepted_turn',updated_at=? WHERE request_id=?")
            .run(started.turnId, Date.now(), intent.requestId)
        }
          const warnings = session
            ? (await deps.contextUsageWarn?.({
                sessionId,
                model: session.model,
                // v2-N2:附件兜底(渲染端放在 contextIntent.create-user.attachments)
                attachments:
                  intent.attachments ?? (intent.contextIntent?.kind === 'create-user' ? intent.contextIntent.attachments : undefined)
              })) ?? []
            : []
          return {
            accepted: 'turn-started',
            sessionId,
            turnId: started.turnId,
            assistantMessage: started.assistantMessage,
            ...(warnings.length ? { warnings } : {})
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          // B4(v2 评审):快照过期竞态（snapshot 未运行 → prepare 时已被占）——降级排队，消息不丢
          if (msg.includes('SESSION_TURN_BUSY')) {
            deps.audit('outbound.submit.degraded_to_queue', { sessionId, requestId: turnIntent.requestId })
            return continuationRouting && intent.requestId ? queueContinuation(sessionId, decision.text) : enqueueDecision(sessionId, decision.text, intent)
          }
          // 准入/配置拒绝（如 TURN_VISION_MODEL_NOT_CONFIGURED 的中文消息）→ 渲染端仅翻译展示
          deps.audit('outbound.submit.rejected', { sessionId, reason: msg, requestId: turnIntent.requestId })
          return { rejected: { reason: msg } }
        }
      }
    }
    } finally {
      admission.ticket.release()
    }
  }

  return { submitOutbound }
}

const TERMINAL_FACT_EVENTS = new Set(['source-completed', 'source-failed', 'source-cancelled', 'source-timeout'])

/**
 * 上下文占用 ≥80% 通过型警告（P2-2）：主进程权威计算，替代渲染端 historyForApi 私算。
 * 返回错误码数组（渲染端仅翻译展示），空数组 = 无警告，照常发起。
 */
export function computeContextPressureWarnings(
  db: AppDatabase,
  sessionId: string,
  attachments?: Message['attachments']
): string[] {
  const session = getSession(db, sessionId)
  if (!session) return []
  const messages = getMessageSkeletons(db, sessionId)
  const usage = getSessionUsage(db, sessionId)
  const lastAssistantThinking = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.thinking)?.thinking
  const thinkingTokensToExclude = estimateThinkingTokensFromMessage(lastAssistantThinking)
  const occupancy = usage ? computeEstimatedOccupancy(usage, { thinkingTokensToExclude }) : 0
  const pendingImageTokens = estimateTokensFromImageAttachments(attachments ?? [])
  const historyImageTokens = estimateTokensFromHistoryImages(messages)
  const modelEntry = readStoredModels(db).find((entry) => entry.name === session.model)
  const cap = resolveEffectiveMaximumContext(session.model, modelEntry?.maximumContext ?? 0)
  if (cap > 0 && historyImageTokens + pendingImageTokens + occupancy > cap * 0.8) {
    return ['OUTBOUND_CONTEXT_PRESSURE_80']
  }
  return []
}

export type OutboundDrainerDeps = {
  submitOutbound: (intent: OutboundSubmitIntent) => Promise<OutboundSubmitResult>
  listActiveCount: (sessionId: string) => number
  getNextQueued: (sessionId: string) => { message: Message; sequence: number; requestId?: string } | null
  /** 消费一条不可由主进程执行的排队条目(本地命令类),由实现层删除落库 */
  consumeQueued: (sessionId: string, messageId: string) => void
  audit: (event: string, data: Record<string, unknown>) => void
}

/** 同一会话连续 rejected 的自动重试上限(防自旋);超过后停摆并落审计,等下一条终态/用户动作 */
const MAX_DRAIN_RETRIES = 3

/**
 * 主进程排水器：turn 终态后取队首 queued 驱动下一回合。
 * 不变量：同一会话同一时刻至多一个 drain；会话仍有 active turn 时不驱动；
 * 队空 / 非 queued / 无 requestId 不驱动；拒绝与异常落审计不静默。
 * B5:排队的本地命令(渲染端本地执行类)由排水器消费(审计 + 删除),不再静默丢弃;
 * B6:rejected/被挡触发的丢触发兜底——drain 结束后若仍「无 active 且队列有可驱动条目」,
 *    微任务自动重排(上限 MAX_DRAIN_RETRIES,成功发起即重置),configuring 失败不再导致队列停摆。
 */
export function createOutboundDrainer(deps: OutboundDrainerDeps) {
  const draining = new Set<string>()
  const retryAttempts = new Map<string, number>()
  /** drain 进行中到达(被挡)的终态触发:B6——结束后必须补扫,否则丢触发导致队列停摆 */
  const suppressedTriggers = new Set<string>()

  function scheduleRetry(sessionId: string): void {
    const n = (retryAttempts.get(sessionId) ?? 0) + 1
    retryAttempts.set(sessionId, n)
    if (n > MAX_DRAIN_RETRIES) {
      deps.audit('outbound.drain.stalled', {
        sessionId,
        attempts: n,
        requestId: deps.getNextQueued(sessionId)?.requestId
      })
      return
    }
    queueMicrotask(() => {
      void drain(sessionId)
    })
  }

  async function drain(sessionId: string): Promise<void> {
    if (draining.has(sessionId)) {
      suppressedTriggers.add(sessionId)
      return
    }
    let started = false
    try {
      started = await drainOnce(sessionId)
    } finally {
      if (draining.has(sessionId)) draining.delete(sessionId)
    }
    if (started) {
      // 已成功发起:后续丢触发由新 turn 的终态投影接管(turn-started 必有 active)
      retryAttempts.delete(sessionId)
      // 但 submitOutbound await 期间可能有终态被挡(如 configuring 立即失败)——仍需补扫一次
      if (suppressedTriggers.has(sessionId)) {
        suppressedTriggers.delete(sessionId)
        if (deps.listActiveCount(sessionId) === 0 && deps.getNextQueued(sessionId)?.message.status === 'queued') {
          scheduleRetry(sessionId)
        }
      }
      return
    }
    if (suppressedTriggers.has(sessionId)) {
      // B6:被挡的终态触发必须补扫(有限次,防自旋)
      suppressedTriggers.delete(sessionId)
      scheduleRetry(sessionId)
      return
    }
    if (deps.listActiveCount(sessionId) > 0) {
      retryAttempts.delete(sessionId)
      return
    }
    if (deps.getNextQueued(sessionId)?.message.status === 'queued') {
      scheduleRetry(sessionId)
    }
  }

  /** 单轮排水:返回 true 表示成功发起了新 turn */
  async function drainOnce(sessionId: string): Promise<boolean> {
    if (draining.has(sessionId)) return false
    try {
      // 单轮循环:驱动一条 turn 后停(等它的终态再触发);本地命令类消费后继续(队列收敛)
      for (;;) {
        if (deps.listActiveCount(sessionId) > 0) return false
        const next = deps.getNextQueued(sessionId)
        if (!next || next.message.role !== 'user' || next.message.status !== 'queued' || !next.requestId) return false
        draining.add(sessionId)
        let result: OutboundSubmitResult
        try {
          result = await deps.submitOutbound({
            sessionId,
            text: next.message.content,
            contextIntent: {
              kind: 'reuse-user',
              currentUser: { message: next.message, order: { kind: 'persisted', sequence: next.sequence } },
              requestId: next.requestId
            }
          })
        } catch (error) {
          deps.audit('outbound.drain.failed', {
            sessionId,
            requestId: next.requestId,
            error: error instanceof Error ? error.message : String(error)
          })
          return false
        } finally {
          draining.delete(sessionId)
        }
        if ('rejected' in result) {
          deps.audit('outbound.drain.rejected', { sessionId, requestId: next.requestId, reason: result.rejected.reason })
          return false
        }
        if (result.accepted === 'turn-started') {
          return true
        }
        if (result.accepted === 'local-command') {
          // B5:主进程无法执行渲染端本地命令(如排队的 /test-cards)——审计 + 消费该条目,继续驱动后续
          deps.audit('outbound.drain.local_command_consumed', {
            sessionId,
            requestId: next.requestId,
            command: result.command.kind
          })
          deps.consumeQueued(sessionId, next.message.id)
          continue
        }
        // queued(理论不可达:reuse-user 排队语义)——审计防静默,跳出等下一次触发
        deps.audit('outbound.drain.unexpected_queued', { sessionId, requestId: next.requestId })
        return false
      }
    } finally {
      if (draining.has(sessionId)) draining.delete(sessionId)
    }
  }

  function onTurnProjection(turn: { sessionId: string }, event: { type: string }): void {
    if (!TERMINAL_FACT_EVENTS.has(event.type)) return
    void drain(turn.sessionId)
  }

  return { drain, onTurnProjection }
}
