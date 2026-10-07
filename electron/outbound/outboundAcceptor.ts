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
import { appendMessage, getSessionUsage, type AppDatabase } from '../database'
import { readStoredModels } from '../llmServiceResolver'
import { createHash } from 'node:crypto'
import { summarizeFailedInvocation } from '../runtime/continuationSummary'
export { summarizeFailedInvocation } from '../runtime/continuationSummary'
import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'
import type { SessionCommands, SessionExecutionStore } from '../sessionStorage/contracts'
import type { ContinuationSourceQueries, ContinuationSourceRef, SessionQueries } from '../sessionStorage/contracts'
import { runInTransaction, TransactionCommitUnknownError } from '../database/transaction'
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
  sessionQueries: SessionQueries
  sessionCommands: Pick<SessionCommands, 'enqueue'>
  sessionExecution: Pick<SessionExecutionStore, 'enqueueAndRecordContinuation' | 'readTurnByRequest' | 'readContinuationIntent' | 'resolveContinuationAcceptance' | 'ensureContinuationStatusMessage' | 'requireContinuationSourceSelection' | 'selectOrdinaryContinuation' | 'bindStartedContinuationTurn' | 'repairPreparedContinuationAcceptance' | 'beginContinuationIntent' | 'finalizeContinuationAcceptance'>
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
  startContinuation?: (input: { sessionId: string; sourceInvocationId: string; source: ContinuationSourceRef; requestId: string; continuationAcceptance: { payloadSha256: string; rawText: string; attachments?: NonNullable<Message['attachments']>; intentKind: 'exact-continue' | 'follow-up'; route: string } }) => Promise<{ continuationId: string; targetTurnId: string; status: string }>
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


export function createOutboundAcceptor(deps: OutboundAcceptorDeps) {
  const intentInFlight = new Map<string, string>()
  const sessionQueries = deps.sessionQueries
  const sessionCommands = deps.sessionCommands
  const sessionExecution = deps.sessionExecution
  const io: OutboundClassifierIo = {
    listSkills: deps.listSkills,
    getSkill: deps.getSkill,
    wikiInit: deps.wikiInit,
    wikiStatus: deps.wikiStatus,
    wikiImportRaw: deps.wikiImportRaw
  }

  const countQueued = (sessionId: string): number => countQueuedUserMessages(sessionQueries.readMessages({ sessionId }), sessionId)

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
    const enqueueInput = {
      sessionId,
      requestId,
      content: text,
      // 附件兜底：渲染端把附件放在 contextIntent.create-user.attachments，排队路径同样带上
      attachments: intent.attachments ?? (intent.contextIntent?.kind === 'create-user' ? intent.contextIntent.attachments : undefined)
    }
    const enqueued = sessionCommands.enqueue(enqueueInput)
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
      const context = routedContinuationSource ? { sourceInvocationId: routedContinuationSource.invocationId, sourceTurnId: routedContinuationSource.turnId, historySequence: routedContinuationSource.sequence, summary: routedContinuationSource.summary, state: routedContinuationSource.state } : undefined
      const attachments = intent.attachments ?? (intent.contextIntent?.kind === 'create-user' ? intent.contextIntent.attachments : undefined)
      const queued = sessionExecution.enqueueAndRecordContinuation({
        enqueue: { sessionId, requestId: intent.requestId!, content: text, attachments },
        intent: {
          payloadSha256: createHash('sha256').update(JSON.stringify({ sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex'),
          rawText: intent.text,
          attachments: intent.attachments,
          intentKind: ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length ? 'exact-continue' : 'follow-up',
          route: routedContinuationSource ? 'context-queue' : 'ordinary-queue',
          ...(routedContinuationSource ? { source: { invocationId: routedContinuationSource.invocationId, turnId: routedContinuationSource.turnId, sequence: routedContinuationSource.sequence }, context } : {})
        }
      })
      deps.notifyEnqueued?.(sessionId)
      return { accepted: 'queued' as const, sessionId, queued: { requestId: queued.receipt.requestId, messageId: queued.persisted.message.id, sequence: queued.persisted.sequence } }
    }
    if (intent.requestId && intent.sessionId && /^(继续|继续执行|接着做|接着刚才的修改|继续上次的任务|接着|刚才|上次)/u.test(intent.text.trim())) {
      continuationRouting = true
      const fingerprint = createHash('sha256').update(JSON.stringify({ sessionId: intent.sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex')
      const prior = sessionExecution.readContinuationIntent({ requestId: intent.requestId, sessionId: intent.sessionId })
      if (prior) {
        const resolved = sessionExecution.resolveContinuationAcceptance({ requestId: intent.requestId, sessionId: intent.sessionId, payloadSha256: fingerprint })
        if (resolved.kind === 'unresolved') return { rejected: { reason: resolved.reason } }
        if (resolved.kind === 'selection-required' && !intent.sourceSelection) return { rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } }
        if (resolved.kind === 'selection-required' && intent.sourceSelection?.asOrdinaryTurn) {
          // Explicit ordinary fallback is finalized under this request ID below.
          sessionExecution.selectOrdinaryContinuation({ requestId: intent.requestId, sessionId: intent.sessionId, text: intent.text, attachments: intent.attachments, payloadSha256: fingerprint, intentKind: ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length ? 'exact-continue' : 'follow-up' })
        }
        if (resolved.kind === 'continuation') return { accepted: 'local-command', sessionId: intent.sessionId, command: { kind: 'continuation-started', messageId: resolved.message.message.id, sequence: resolved.message.sequence } }
        if (resolved.kind === 'queued') return { accepted: 'queued', sessionId: intent.sessionId, queued: { requestId: intent.requestId, messageId: resolved.message.message.id, sequence: resolved.message.sequence } }
        if (resolved.kind === 'turn') return { accepted: 'turn-started', sessionId: resolved.turn.sessionId, turnId: resolved.turn.turnId, assistantMessage: resolved.assistant }
        if (resolved.kind === 'starting') return { rejected: { reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' } }
        if (prior.status === 'rejected_retryable' || prior.status === 'commit_uncertain') return { rejected: { reason: prior.rejectionReason ?? prior.status } }
      }
      const locked = intentInFlight.get(intent.requestId)
      if (locked && locked !== fingerprint) return { rejected: { reason: 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT' } }
      if (locked) return { rejected: { reason: 'CONTINUATION_INTENT_IN_PROGRESS' } }
      intentInFlight.set(intent.requestId, fingerprint)
      try {
        const now = Date.now()
        const exact = ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length
        const activeTurnIds = new Set(deps.turnRuntime.listActive(intent.sessionId).map((turn) => turn.turnId))
        const sourceInspection = sessionQueries.continuationSources.inspect({ sessionId: intent.sessionId, activeTurnIds: [...activeTurnIds], ...(intent.sourceSelection?.sourceAssistantMessageId ? { selectedAssistantMessageId: intent.sourceSelection.sourceAssistantMessageId } : {}) })
        if (sourceInspection.kind === 'unavailable') throw new Error(sourceInspection.reason)
        const failedCandidates = sourceInspection.failedCandidates.map((candidate) => ({ ...candidate, invocationId: candidate.source.invocationId, turnId: candidate.source.turnId, sourceRef: candidate.source, snapshot: candidate.snapshot }))
        let source = sourceInspection.selected.kind === 'found'
          ? { ...sourceInspection.selected.candidate, invocationId: sourceInspection.selected.candidate.source.invocationId, turnId: sourceInspection.selected.candidate.source.turnId, sourceRef: sourceInspection.selected.candidate.source, snapshot: sourceInspection.selected.candidate.snapshot }
          : failedCandidates.length === 1 ? failedCandidates[0] : undefined
        if (failedCandidates.length > 1 && intent.sourceSelection?.chooseLatest) source = failedCandidates[0]
        if (failedCandidates.length > 1 && !intent.sourceSelection && !prior) {
          sessionExecution.requireContinuationSourceSelection({ requestId: intent.requestId!, sessionId: intent.sessionId!, text: intent.text, attachments: intent.attachments, payloadSha256: fingerprint, intentKind: exact ? 'exact-continue' : 'follow-up' })
          return { rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } }
        }
        if (!source && failedCandidates.length > 1 && !intent.sourceSelection && !prior) {
          sessionExecution.requireContinuationSourceSelection({ requestId: intent.requestId!, sessionId: intent.sessionId!, text: intent.text, attachments: intent.attachments, payloadSha256: fingerprint, intentKind: exact ? 'exact-continue' : 'follow-up' })
          return { rejected: { reason: 'CONTINUATION_SOURCE_SELECTION_REQUIRED' } }
        }
        const ordinarySourceOverride = !source && failedCandidates.length > 1 && intent.sourceSelection?.asOrdinaryTurn === true
        if (!source && intent.sourceSelection?.sourceAssistantMessageId) {
          if (sourceInspection.selected.kind !== 'found') return { rejected: { reason: sourceInspection.selected.kind === 'not-recoverable' ? 'CONTINUATION_SOURCE_NOT_RECOVERABLE' : 'CONTINUATION_SOURCE_NOT_FOUND' } }
        }
        if (!source && !ordinarySourceOverride && failedCandidates.length === 0) {
          if (intent.sourceSelection?.asOrdinaryTurn) {
            sessionExecution.selectOrdinaryContinuation({ requestId: intent.requestId!, sessionId: intent.sessionId!, text: intent.text, attachments: intent.attachments, payloadSha256: fingerprint, intentKind: exact ? 'exact-continue' : 'follow-up' })
          } else if (intent.sourceSelection?.sourceAssistantMessageId) {
            if (sourceInspection.selected.kind !== 'found') return { rejected: { reason: sourceInspection.selected.kind === 'not-recoverable' ? 'CONTINUATION_SOURCE_NOT_RECOVERABLE' : 'CONTINUATION_SOURCE_NOT_FOUND' } }
            source = { ...sourceInspection.selected.candidate, invocationId: sourceInspection.selected.candidate.source.invocationId, turnId: sourceInspection.selected.candidate.source.turnId, sourceRef: sourceInspection.selected.candidate.source, snapshot: sourceInspection.selected.candidate.snapshot }
          }
        }
        if (!source && failedCandidates.length === 0) {
          const relationCue = /^(继续|接着|刚才|上次)/u.test(intent.text.trim())
          if (relationCue && sourceInspection.kind === 'available' && sourceInspection.fallback) {
            const summary = sourceInspection.fallback.summary
            routedContinuationSource = { invocationId: summary.invocationId, turnId: summary.turnId, sequence: summary.sequence, summary: summary.summary, state: summary.state }
          }
        }
        if (source && exact && !intent.attachments?.length && deps.startContinuation) {
          // Start the already validated source checkpoint from this same stable input request.
          let continuationStarted = false
          try {
            sessionExecution.beginContinuationIntent({
              requestId: intent.requestId!, sessionId: intent.sessionId!, text: intent.text, attachments: intent.attachments,
              payloadSha256: fingerprint, intentKind: 'exact-continue',
              source: source.sourceRef
            })
            const started = await deps.startContinuation({ sessionId: intent.sessionId, sourceInvocationId: source.invocationId, source: source.sourceRef, requestId: intent.requestId, continuationAcceptance: { payloadSha256: fingerprint, rawText: intent.text, attachments: intent.attachments, intentKind: 'exact-continue', route: 'continuation' } })
            continuationStarted = true
            const finalized = sessionExecution.finalizeContinuationAcceptance({ requestId: intent.requestId!, sessionId: intent.sessionId!, payloadSha256: fingerprint, continuationId: started.continuationId })
            return { accepted: 'local-command', sessionId: intent.sessionId, command: { kind: 'continuation-started', messageId: finalized.statusMessage.message.id, sequence: finalized.statusMessage.sequence } }
          } catch (error) {
            // Unsafe checkpoints become a context-only new Turn with the original text and attachments.
            if (error instanceof Error && error.message === 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT') throw error
            if (continuationStarted || error instanceof TransactionCommitUnknownError) return { rejected: { reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' } }
            if (error instanceof Error && error.message === 'CONTINUATION_SOURCE_STALE') {
              // Keep the input as an ordinary new Turn without inheriting an out-of-date failure.
            } else {
            const summary = source.summary
            routedContinuationSource = { invocationId: summary.invocationId, turnId: summary.turnId, sequence: summary.sequence, summary: summary.summary, state: summary.state }
            }
          }
        } else if (source && !(exact && !intent.attachments?.length && deps.startContinuation)) {
          const summary = source.summary
          routedContinuationSource = { invocationId: summary.invocationId, turnId: summary.turnId, sequence: summary.sequence, summary: summary.summary, state: summary.state }
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
      if (sessionId && sessionQueries.readSession(sessionId)) {
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
    } else if (!sessionQueries.readSession(sessionId)) {
      const reason = 'OUTBOUND_SESSION_NOT_FOUND'
      deps.audit('outbound.submit.rejected', { sessionId, reason })
      return { rejected: { reason } }
    }

    const session = sessionQueries.readSession(sessionId)
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
          if (!sessionExecution.readContinuationIntent({ requestId: intent.requestId, sessionId })) {
            sessionExecution.repairPreparedContinuationAcceptance({
              requestId: intent.requestId, sessionId, text: intent.text, attachments: intent.attachments,
              payloadSha256: createHash('sha256').update(JSON.stringify({ sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex'),
              intentKind: ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length ? 'exact-continue' : 'follow-up',
              route: routedContinuationSource ? 'context-turn' : 'ordinary', turnId: target.turnId,
              ...(routedContinuationSource ? { source: { invocationId: routedContinuationSource.invocationId, turnId: routedContinuationSource.turnId, sequence: routedContinuationSource.sequence } } : {}),
              ...(retrySource ? { retrySource: { assistantMessageId: retrySource.assistantMessageId, invocationId: retrySource.sourceInvocationId } } : {})
            })
          }
          sessionExecution.bindStartedContinuationTurn({
            requestId: intent.requestId, sessionId, text: intent.text, attachments: intent.attachments,
            payloadSha256: createHash('sha256').update(JSON.stringify({ sessionId, text: intent.text, attachments: intent.attachments ?? null })).digest('hex'),
            intentKind: ['继续', '继续执行', '接着做', '接着刚才的修改', '继续上次的任务'].includes(intent.text.trim()) && !intent.attachments?.length ? 'exact-continue' : 'follow-up',
            route: routedContinuationSource ? 'context-turn' : 'ordinary', turnId: target.turnId,
            ...(routedContinuationSource ? { source: { invocationId: routedContinuationSource.invocationId, turnId: routedContinuationSource.turnId, sequence: routedContinuationSource.sequence } } : {}),
            ...(retrySource ? { retrySource: { assistantMessageId: retrySource.assistantMessageId, invocationId: retrySource.sourceInvocationId } } : {})
          })
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
  attachments: Message['attachments'] | undefined,
  sessionQueries: SessionQueries
): string[] {
  const session = sessionQueries.readSession(sessionId)
  if (!session) return []
  const messages = sessionQueries.readMessages({ sessionId })
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
