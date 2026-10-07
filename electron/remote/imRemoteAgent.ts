import type { AppDatabase } from '../database'
import { getConfigValue } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { assembleInvocation, type AgentInvocationMaterials } from '../runtime/invocationAssembler'
import { buildResolveWorkDirCallback, resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { ModelEntry } from '../../src/shared/domainTypes'
import { resolveModelContextWindow } from '../../src/shared/llmModelConfig'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import type { RemoteContext } from '../tools/types'
import { getCallAdmissionGate } from '../runtime/callAdmissionGate'
import { readAppLocale } from '../appIpc'
import { resolveLlmCredentialsForModel } from '../llmServiceResolver'
import { logHistoryOversizedToolResult } from '../oversizedToolResultLog'
import {
  startRemoteProgressSession,
  stopRemoteProgressSession,
  type RemoteProgressAdapter
} from './remoteProgressCoordinator'
import { clearRemoteProgressSession } from './remoteProgressStore'
import type { RemoteProgressConfig } from '../../src/shared/remoteProgressTypes'
import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import {
  resolveFeishuBrowserRemoteHint,
  type FeishuBrowserRemoteHint
} from '../../src/shared/browserRemotePolicy'
import { resolveRemoteOutboundSessionId } from './remoteSessionSwitchFollow'
import { requireInvocationAnthropicRoute } from '../runtime/invocationProviderRoute'
import { createHostedTurnHandoff } from '../runtime/hostedTurnHandoff'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { getSessionEventSink } from '../sessionEvents'
import { HostedTurnFinalizedError, hostedTerminalSessionEventReason } from '../runtime/hostedTurnFinalization'
import { buildRemoteProgressHookContext } from './buildRemoteProgressContext'
import { onRemoteTextSegmentClosed } from './remoteProgressHooks'
import type { AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { SessionStorage } from '../sessionStorage/contracts'

export function extractTextFromContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') s += t
    }
  }
  return s.trim()
}

export type ImRemoteAgentResult = { summary: string; pendingConfirm: boolean; ok: boolean; outcome?: 'cancelled' | 'timed-out' }

export async function runImRemoteAgent(args: {
  /** B1(偏差 23):准入门注入(测试);缺省全局默认门。 */
  admissionGate?: import('../runtime/callAdmissionGate').CallAdmissionGate
  db: AppDatabase
  sessionStorage?: SessionStorage
  sessionId: string
  requestId: string
  /** 本回合真实 Turn ID（C17）：由 router 的 prepared.turnId 下传，供用量统计落库。 */
  turnId?: string
  acceptedTurn?: AcceptedTurn
  /** 冻结执行配置里的 LLM 服务 ID（DIM3：同模型跨服务分开统计）。 */
  llmServiceId?: string
  workDir: string
  workDirManager: WorkDirManager
  userDataDir: string
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  remoteContext: RemoteContext
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getWikiConfig?: () => WikiConfig
  getShellConfig?: () => ShellConfig
  createProgressAdapter: (getSessionId: () => string) => RemoteProgressAdapter
  buildSystemAppendix: (args: { browserRemoteHint?: FeishuBrowserRemoteHint }) => string
  progressDefaults: Required<RemoteProgressConfig>
  progressConfig: RemoteProgressConfig
  toolChatExtras?: Pick<AgentInvocationMaterials, 'feishuConfig' | 'wechatConfig' | 'larkCliRunner'>
  onFinally?: () => void
  /** WeChat historically rethrows as `new Error(message)`. */
  rethrowAsError?: boolean
  logSensitiveBlocked?: () => void
  logDone?: (result: ImRemoteAgentResult & { error?: string }) => void
  logError?: (error: string) => void
  emitFactEvent?: (event: AssistantFactEvent) => void
}): Promise<ImRemoteAgentResult> {
  const requestId = args.requestId
  const injectedStorage = args.sessionStorage
  if (!injectedStorage) return { summary: '会话存储不可用。', pendingConfirm: false, ok: false }
  const storage: SessionStorage = injectedStorage

  // B1(偏差 23):调用级准入——远端发起入口(四处之一)。票据覆盖整回合,拒绝即答复「资源忙」。
  const admissionGate = args.admissionGate ?? getCallAdmissionGate()
  const admission = await admissionGate.acquire({
    lane: args.remoteContext.source,
    priority: 'interactive',
    role: 'top-level',
    disposition: 'reject',
    requestId,
    turnId: args.turnId ?? requestId
  })
  if (!admission.ok) {
    return {
      summary: admission.verdict === 'rejected' ? '当前调用并发已达上限，请稍后再试。' : '当前调用已被限流，请稍后再试。',
      pendingConfirm: false,
      ok: false
    }
  }


  try {
    const getOutboundSessionId = () => resolveRemoteOutboundSessionId(args.remoteContext, args.sessionId)
    const adapter = args.createProgressAdapter(getOutboundSessionId)
    // P2(评审):progress session 启动在票据持有窗口内——挪进 try,同步抛出也走 release
    startRemoteProgressSession(args.sessionId, adapter, args.progressConfig, args.progressDefaults)
    return await runAdmittedTurn()
  } finally {
    admission.ticket.release()
  }

  async function runAdmittedTurn(): Promise<ImRemoteAgentResult> {
  let sessionEventReason = 'failed'
  let sessionEventError: string | undefined
  let sessionEventStarted = false
  let turnIdForEvents = args.turnId ?? requestId
  let sessionEventLocation: { workDir: string; sessionId: string; createdAt: number } | undefined
  let sessionEventSink: ReturnType<typeof getSessionEventSink> | undefined
  try {
    const resolved = resolveWorkDirForSession(
      storage.queries,
      args.sessionId,
      () => args.workDirManager.listProfiles(),
      () => args.workDirManager.getActiveProfileId(),
      () => args.workDirManager.getActiveWorkDir()
    )
    if (resolved?.isSensitive) {
      args.logSensitiveBlocked?.()
      return { summary: SENSITIVE_WORKDIR_ERROR, pendingConfirm: false, ok: false }
    }

    const persistedSession = storage.queries.readSession(args.sessionId)
    sessionEventLocation = persistedSession && resolved?.workDir
      ? { workDir: resolved.workDir, sessionId: args.sessionId, createdAt: persistedSession.createdAt }
      : undefined
    sessionEventSink = sessionEventLocation
      ? getSessionEventSink(sessionEventLocation.workDir, sessionEventLocation.sessionId, sessionEventLocation.createdAt)
      : undefined
    if (sessionEventSink) {
      await sessionEventSink.appendCritical({ type: 'turn_start', payload: { turnId: turnIdForEvents } })
      await sessionEventSink.appendCritical({ type: 'step_start', payload: { turnId: turnIdForEvents, stepId: requestId } })
      sessionEventStarted = true
    }

    const toolsConfig = args.getToolsConfig()
    let rawMessages: import('../../src/shared/domainTypes').Message[]
    let acceptedUserMessageId: string | undefined
    if (args.turnId) {
      const persisted = storage.execution.readTurn({ sessionId: args.sessionId, turnId: args.turnId })
      if (!persisted || persisted.sessionId !== args.sessionId || persisted.requestId !== requestId) {
        throw new Error('TURN_EXECUTION_CREDENTIALS_INVALID')
      }
      if (persisted.state === 'configuring') throw new Error('TURN_EXECUTION_CONFIGURING')
      rawMessages = storage.execution.loadAcceptedMessages({ sessionId: args.sessionId, turnId: args.turnId })
      acceptedUserMessageId = persisted.userMessageId
    } else {
      rawMessages = storage.queries.readMessages({ sessionId: args.sessionId })
    }
    const built = buildClaudeToolChatMessages(rawMessages, {
      workspaceRoot: resolved?.workDir,
      onOversizedToolResult: (info) => {
        logHistoryOversizedToolResult({
          sessionId: args.sessionId,
          toolUseId: info.toolUseId,
          originalLength: info.originalLength,
          compactedLength: info.compactedLength,
          source: 'im-remote'
        })
      }
    })
    const trimmed = trimClaudeToolChatMessages(built, MAX_CHAT_API_MESSAGES)
    const currentUserMessageId = acceptedUserMessageId ?? [...rawMessages].reverse().find((message) => message.role === 'user')?.id
    const { messages } = ensureToolResultPairing(trimmed, { requiredUserMessageId: currentUserMessageId })

    const browserConfig = args.getBrowserConfig?.()
    const appendix = args.buildSystemAppendix({
      browserRemoteHint: resolveFeishuBrowserRemoteHint(
        browserConfig?.enabled,
        browserConfig?.allowRemoteSessions
      )
    })

    const routeModelName = args.getModel()
    let contextWindow: number | undefined
    let contextWindowTrusted = false
    try {
      const models = JSON.parse(getConfigValue(args.db, 'config.models') ?? '[]') as ModelEntry[]
      const modelWindow = resolveModelContextWindow(routeModelName, models)
      contextWindow = modelWindow.contextWindow
      contextWindowTrusted = modelWindow.trusted
    } catch { /* use adapter fallback */ }
    const creds = await resolveLlmCredentialsForModel(args.db, routeModelName, {})
    const baseUrl = creds.baseUrl ?? args.getBaseUrl()
    const getApiKey = creds.error ? args.getApiKey : creds.getApiKey
    const modelEntry = (() => {
      try { return (JSON.parse(getConfigValue(args.db, 'config.models') ?? '[]') as ModelEntry[]).find((entry) => entry.name === routeModelName) }
      catch { return undefined }
    })()
    const providerRouteId = requireInvocationAnthropicRoute({
      modelId: modelEntry?.id ?? routeModelName,
      endpoint: baseUrl,
      credentialRef: `llm-service:${creds.serviceId || args.llmServiceId || 'default'}`
    }, getDefaultAgentRuntime().modelProviders)
    const remoteProgressContext = buildRemoteProgressHookContext(args.sessionId, readAppLocale(args.db))

    const { invocation, ports, agentSdk } = assembleInvocation({
      requestId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      acceptedTurn: args.acceptedTurn,
      // DIM3：统计维度以实际解析出的服务为准——resolver 未指定 serviceId 时可能回落默认服务，
      // 会话冻结配置（args.llmServiceId）仅作 resolver 失败时的兜底（评审 P1-2）。
      llmServiceId: creds.serviceId || args.llmServiceId,
      model: routeModelName,
      ...(modelEntry?.id ? { modelId: modelEntry.id } : {}),
      providerRouteId,
      contextWindow,
      contextWindowTrusted,
      baseUrl,
      messages,
      system: appendix,
      options: { maxTokens: 8192 },
      currentUserMessageId,
      toolsConfig,
      resolveToolsConfig: args.getToolsConfig,
      resolveBrowserConfig: args.getBrowserConfig,
      resolveShellConfig: args.getShellConfig,
      resolveWikiConfig: args.getWikiConfig,
      browserConfig: args.getBrowserConfig?.(),
      wikiConfig: args.getWikiConfig?.(),
      shellConfig: args.getShellConfig?.(),
      workDir: args.workDir,
      workDirManager: args.workDirManager,
      resolveWorkDir: buildResolveWorkDirCallback(
        storage.queries,
        args.sessionId,
        args.workDirManager,
        args.workDir
      ),
      userDataDir: args.userDataDir,
      getApiKey,
      appDb: args.db,
      sessionStorage: storage,
      historyForSession: (sessionId: string) => storage.execution.historyFor({ sessionId }),
      ...(sessionEventLocation ? { sessionEventLocation } : {}),
      remoteContext: args.remoteContext,
      onRemoteTextActivity: (text) => onRemoteTextSegmentClosed(remoteProgressContext, text),
      locale: readAppLocale(args.db),
      ...args.toolChatExtras
      ,emitFactEvent: args.emitFactEvent ?? (() => undefined)
      ,emitSessionEvent: async (event) => { await sessionEventSink?.appendCritical(event) }
    })
    const res = await runToolChatSession(invocation, ports, {
      onHostedTurnHandoff: createHostedTurnHandoff({
        agentSdk, history: ports.history!, invocationId: args.acceptedTurn?.turnId ?? args.turnId ?? requestId, turnId: args.acceptedTurn?.turnId ?? args.turnId ?? requestId, acceptedTurn: args.acceptedTurn,
        sessionQueries: storage.queries, sessionExecution: storage.execution, routeId: providerRouteId, sessionId: args.sessionId, maxToolRounds: invocation.limits.maxToolRounds,
      })
    })

    if (!res.ok) {
      sessionEventReason = res.cancelled ? 'cancelled' : 'failed'
      const pending = res.error.includes('确认')
      const result = { summary: res.error, pendingConfirm: pending, ok: false as const, ...(res.cancelled ? { outcome: 'cancelled' as const } : {}) }
      args.logDone?.({ ...result, error: res.error })
      return result
    }

    const text = extractTextFromContent(res.content)
    sessionEventReason = 'completed'
    const result = { summary: text || '任务已完成。', pendingConfirm: false, ok: true as const }
    args.logDone?.(result)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (e instanceof HostedTurnFinalizedError) sessionEventReason = hostedTerminalSessionEventReason(e.outcome)
    sessionEventError = error
    args.logError?.(error)
    if (args.rethrowAsError) throw e instanceof Error ? e : new Error(error)
    throw e
  } finally {
    if (sessionEventStarted) {
      if (sessionEventLocation && sessionEventSink) {
        try {
          await sessionEventSink.appendCritical({ type: 'step_end', payload: { turnId: turnIdForEvents, stepId: requestId, reason: sessionEventReason } })
          await sessionEventSink.appendCritical({ type: 'turn_end', payload: { turnId: turnIdForEvents, reason: sessionEventReason, ...(sessionEventError ? { error: sessionEventError } : {}) } })
        } catch (error) {
          try { args.logError?.(`remote session event finalization failed: ${error instanceof Error ? error.message : String(error)}`) }
          catch { /* event diagnostics must not replace the turn outcome */ }
        }
      }
    }
    stopRemoteProgressSession(args.sessionId)
    clearRemoteProgressSession(args.sessionId)
    args.onFinally?.()
  }
  }
}
