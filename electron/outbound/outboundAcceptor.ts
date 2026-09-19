import type { Message, SessionSkillsState, SkillDefinition, WikiConfig, WikiStatus } from '../../src/shared/domainTypes'
import { normalizeSessionSkillsState } from '../../src/shared/domainTypes'
import { MAX_CHAT_MESSAGE_QUEUE_SIZE, countQueuedUserMessages } from '../../src/shared/chatMessageQueue'
import type { OutboundSubmitIntent, OutboundSubmitResult } from '../../src/shared/outboundProtocol'
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
import { getMessages, getSession, getSessionUsage, enqueueQueuedUserMessage, type AppDatabase } from '../database'
import { readStoredModels } from '../llmServiceResolver'

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
  | { action: 'start-turn'; text: string; skillsState?: SessionSkillsState; wikiModeActive?: boolean }

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
  if (wikiCmd.type === 'run') {
    chatText = wikiCmd.text
    skillsState = wikiCmd.skillsState
    wikiModeActive = true
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
    ...(skillsState !== snapshot.sessionSkillsState ? { skillsState } : {}),
    ...(wikiModeActive ? { wikiModeActive: true } : {})
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
  appendHintMessage: (sessionId: string, hint: string) => Promise<void> | void
  updateSessionState: (
    sessionId: string,
    patch: { skillsState?: SessionSkillsState; metadataPatch?: Record<string, unknown> }
  ) => Promise<void> | void
  createSession: () => Promise<Pick<Session_Requested, 'id'>> | Pick<Session_Requested, 'id'>
  startTurn: OutboundTurnStarter
  /** 占用 ≥80% 通过型警告（P2-2）：返回错误码数组，随 turn-started.warnings 透出 */
  contextUsageWarn?: (input: { sessionId: string; model: string; attachments?: Message['attachments'] }) => Promise<string[]>
  newRequestId: () => string
  audit: (event: string, data: Record<string, unknown>) => void
}

/** 仅取 id 的会话形（避免拉入完整 Session 类型依赖） */
type Session_Requested = { id: string }

export function createOutboundAcceptor(deps: OutboundAcceptorDeps) {
  const io: OutboundClassifierIo = {
    listSkills: deps.listSkills,
    getSkill: deps.getSkill,
    wikiInit: deps.wikiInit,
    wikiStatus: deps.wikiStatus,
    wikiImportRaw: deps.wikiImportRaw
  }

  const countQueued = (sessionId: string): number => countQueuedUserMessages(getMessages(deps.db, sessionId), sessionId)

  async function submitOutbound(intent: OutboundSubmitIntent): Promise<OutboundSubmitResult> {
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

    // 会话解析/创建：无会话 = 请主进程创建（决定回主进程）
    let sessionId = intent.sessionId
    if (!sessionId) {
      const created = await deps.createSession()
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
        return { accepted: 'local-command', command: decision.command }
      case 'hint-only': {
        await deps.appendHintMessage(sessionId, decision.hint)
        if (decision.skillsState) {
          await deps.updateSessionState(sessionId, { skillsState: decision.skillsState })
        }
        return { accepted: 'local-command', command: { kind: 'hint-only', hint: decision.hint } }
      }
      case 'reject': {
        deps.audit('outbound.submit.rejected', { sessionId, reason: decision.reason })
        return { rejected: { reason: decision.reason } }
      }
      case 'enqueue': {
        // 幂等凭证：reuse-user（排水）透传原 requestId，否则新生成
        const requestId =
          intent.contextIntent?.kind === 'reuse-user' && intent.contextIntent.requestId
            ? intent.contextIntent.requestId
            : deps.newRequestId()
        await enqueueQueuedUserMessage(deps.db, {
          sessionId,
          requestId,
          content: decision.text,
          attachments: intent.attachments
        })
        return { accepted: 'queued', sessionId }
      }
      case 'start-turn': {
        if (decision.skillsState || decision.wikiModeActive) {
          await deps.updateSessionState(sessionId, {
            ...(decision.skillsState ? { skillsState: decision.skillsState } : {}),
            ...(decision.wikiModeActive
              ? { metadataPatch: patchSessionWikiState(session?.metadata, { wikiModeActive: true }) }
              : {})
          })
        }
        const contextIntent = intent.contextIntent
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
                requestId: deps.newRequestId(),
                sessionId,
                input: {
                  text: decision.text,
                  attachments: intent.attachments ?? (contextIntent?.kind === 'create-user' ? contextIntent.attachments : undefined)
                },
                config: {}
              }
        try {
          const started = await deps.startTurn({ turnIntent })
          const warnings = session
            ? (await deps.contextUsageWarn?.({ sessionId, model: session.model, attachments: intent.attachments })) ?? []
            : []
          return {
            accepted: 'turn-started',
            sessionId,
            turnId: started.turnId,
            assistantMessage: started.assistantMessage,
            ...(warnings.length ? { warnings } : {})
          }
        } catch (error) {
          // 准入/配置拒绝（如 TURN_VISION_MODEL_NOT_CONFIGURED）→ 错误码拒绝，渲染端仅翻译展示
          const reason = error instanceof Error ? error.message : String(error)
          deps.audit('outbound.submit.rejected', { sessionId, reason, requestId: turnIntent.requestId })
          return { rejected: { reason } }
        }
      }
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
  const messages = getMessages(db, sessionId)
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
  audit: (event: string, data: Record<string, unknown>) => void
}

/**
 * 主进程排水器：turn 终态后取队首 queued 驱动下一回合。
 * 不变量：同一会话同一时刻至多一个 drain；会话仍有 active turn 时不驱动；
 * 队空 / 非 queued / 无 requestId 不驱动；拒绝与异常落审计不静默。
 */
export function createOutboundDrainer(deps: OutboundDrainerDeps) {
  const draining = new Set<string>()

  async function drain(sessionId: string): Promise<void> {
    if (draining.has(sessionId)) return
    if (deps.listActiveCount(sessionId) > 0) return
    const next = deps.getNextQueued(sessionId)
    if (!next || next.message.role !== 'user' || next.message.status !== 'queued' || !next.requestId) return
    draining.add(sessionId)
    try {
      const result = await deps.submitOutbound({
        sessionId,
        text: next.message.content,
        contextIntent: {
          kind: 'reuse-user',
          currentUser: { message: next.message, order: { kind: 'persisted', sequence: next.sequence } },
          requestId: next.requestId
        }
      })
      if ('rejected' in result) {
        deps.audit('outbound.drain.rejected', { sessionId, requestId: next.requestId, reason: result.rejected.reason })
      }
    } catch (error) {
      deps.audit('outbound.drain.failed', {
        sessionId,
        requestId: next.requestId,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      draining.delete(sessionId)
    }
  }

  function onTurnProjection(turn: { sessionId: string }, event: { type: string }): void {
    if (!TERMINAL_FACT_EVENTS.has(event.type)) return
    void drain(turn.sessionId)
  }

  return { drain, onTurnProjection }
}
