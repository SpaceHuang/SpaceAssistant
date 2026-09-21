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
  | {
      action: 'start-turn'
      text: string
      skillsState?: SessionSkillsState
      wikiModeActive?: boolean
      /** B3:wiki run 等「先提示后发起」的用户反馈,随发起落库(main 语义保持) */
      hint?: string
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
  const io: OutboundClassifierIo = {
    listSkills: deps.listSkills,
    getSkill: deps.getSkill,
    wikiInit: deps.wikiInit,
    wikiStatus: deps.wikiStatus,
    wikiImportRaw: deps.wikiImportRaw
  }

  const countQueued = (sessionId: string): number => countQueuedUserMessages(getMessages(deps.db, sessionId), sessionId)

  /** 排队落库（v2-B4 降级与 enqueue 决定共用）：幂等凭证、附件兜底、落库后补触发（v2-B3） */
  async function enqueueDecision(
    sessionId: string,
    text: string,
    intent: OutboundSubmitIntent
  ): Promise<Extract<OutboundSubmitResult, { accepted: 'queued' }>> {
    // 幂等凭证：reuse-user（排水）透传原 requestId，否则新生成
    const requestId =
      intent.contextIntent?.kind === 'reuse-user' && intent.contextIntent.requestId
        ? intent.contextIntent.requestId
        : deps.newRequestId()
    const enqueued = await enqueueQueuedUserMessage(deps.db, {
      sessionId,
      requestId,
      content: text,
      // 附件兜底：渲染端把附件放在 contextIntent.create-user.attachments，排队路径同样带上
      attachments: intent.attachments ?? (intent.contextIntent?.kind === 'create-user' ? intent.contextIntent.attachments : undefined)
    })
    deps.notifyEnqueued?.(sessionId)
    return {
      accepted: 'queued',
      sessionId,
      queued: { requestId, messageId: enqueued.persisted.message.id, sequence: enqueued.persisted.sequence }
    }
  }

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

    // B1(偏差 23):调用级准入——桌面受理端口(四处发起入口之一,评审 N2 口径)。
    // 受理级票据(瞬时)+ 全局速率约束;queue 语义由既有会话级出站排队承载,故此处声明 reject。
    const admissionGate = deps.admissionGate ?? getCallAdmissionGate()
    const admission = await admissionGate.acquire({
      lane: 'desktop',
      priority: 'interactive',
      role: 'top-level',
      disposition: 'reject',
      requestId: deps.newRequestId()
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
            return enqueueDecision(sessionId, decision.text, intent)
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
