import type { AppDatabase } from '../database'
import { getMessages, getConfigValue } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { assembleInvocation, type AgentInvocationMaterials } from '../runtime/invocationAssembler'
import { buildResolveWorkDirCallback, resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { ModelEntry } from '../../src/shared/domainTypes'
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
  sessionId: string
  requestId: string
  /** 本回合真实 Turn ID（C17）：由 router 的 prepared.turnId 下传，供用量统计落库。 */
  turnId?: string
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

  // B1(偏差 23):调用级准入——远端发起入口(四处之一)。票据覆盖整回合,拒绝即答复「资源忙」。
  const admissionGate = args.admissionGate ?? getCallAdmissionGate()
  const admission = await admissionGate.acquire({
    lane: args.remoteContext.source,
    priority: 'interactive',
    role: 'top-level',
    disposition: 'reject',
    requestId
  })
  if (!admission.ok) {
    return {
      summary: admission.verdict === 'rejected' ? '当前调用并发已达上限，请稍后再试。' : '当前调用已被限流，请稍后再试。',
      pendingConfirm: false,
      ok: false
    }
  }

  const getOutboundSessionId = () => resolveRemoteOutboundSessionId(args.remoteContext, args.sessionId)
  const adapter = args.createProgressAdapter(getOutboundSessionId)
  startRemoteProgressSession(args.sessionId, adapter, args.progressConfig, args.progressDefaults)

  try {
    return await runAdmittedTurn()
  } finally {
    if (admission.ok) admission.ticket.release()
  }

  async function runAdmittedTurn(): Promise<ImRemoteAgentResult> {
  try {
    const resolved = resolveWorkDirForSession(
      args.db,
      args.sessionId,
      () => args.workDirManager.listProfiles(),
      () => args.workDirManager.getActiveProfileId(),
      () => args.workDirManager.getActiveWorkDir()
    )
    if (resolved?.isSensitive) {
      args.logSensitiveBlocked?.()
      return { summary: SENSITIVE_WORKDIR_ERROR, pendingConfirm: false, ok: false }
    }

    const toolsConfig = args.getToolsConfig()
    const rawMessages = getMessages(args.db, args.sessionId)
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
    const { messages } = ensureToolResultPairing(trimmed)

    const browserConfig = args.getBrowserConfig?.()
    const appendix = args.buildSystemAppendix({
      browserRemoteHint: resolveFeishuBrowserRemoteHint(
        browserConfig?.enabled,
        browserConfig?.allowRemoteSessions
      )
    })

    const routeModelName = args.getModel()
    let contextWindow: number | undefined
    try {
      const models = JSON.parse(getConfigValue(args.db, 'config.models') ?? '[]') as ModelEntry[]
      contextWindow = models.find((entry) => entry.name === routeModelName)?.maximumContext
    } catch { /* use adapter fallback */ }
    const creds = await resolveLlmCredentialsForModel(args.db, routeModelName, {})
    const baseUrl = creds.baseUrl ?? args.getBaseUrl()
    const getApiKey = creds.error ? args.getApiKey : creds.getApiKey

    const { invocation, ports } = assembleInvocation({
      requestId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      // DIM3：统计维度以实际解析出的服务为准——resolver 未指定 serviceId 时可能回落默认服务，
      // 会话冻结配置（args.llmServiceId）仅作 resolver 失败时的兜底（评审 P1-2）。
      llmServiceId: creds.serviceId || args.llmServiceId,
      model: routeModelName,
      contextWindow,
      baseUrl,
      messages,
      system: appendix,
      options: { maxTokens: 8192 },
      currentUserMessageId: [...rawMessages].reverse().find((message) => message.role === 'user')?.id,
      toolsConfig,
      browserConfig: args.getBrowserConfig?.(),
      wikiConfig: args.getWikiConfig?.(),
      shellConfig: args.getShellConfig?.(),
      workDir: args.workDir,
      workDirManager: args.workDirManager,
      resolveWorkDir: buildResolveWorkDirCallback(
        args.db,
        args.sessionId,
        args.workDirManager,
        args.workDir
      ),
      userDataDir: args.userDataDir,
      getApiKey,
      appDb: args.db,
      remoteContext: args.remoteContext,
      locale: readAppLocale(args.db),
      ...args.toolChatExtras
      ,emitFactEvent: args.emitFactEvent ?? (() => undefined)
      ,emitSessionEvent: async () => undefined
    })
    const res = await runToolChatSession(invocation, ports)

    if (!res.ok) {
      const pending = res.error.includes('确认')
      const result = { summary: res.error, pendingConfirm: pending, ok: false as const, ...(res.cancelled ? { outcome: 'cancelled' as const } : {}) }
      args.logDone?.({ ...result, error: res.error })
      return result
    }

    const text = extractTextFromContent(res.content)
    const result = { summary: text || '任务已完成。', pendingConfirm: false, ok: true as const }
    args.logDone?.(result)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    args.logError?.(error)
    if (args.rethrowAsError) throw new Error(error)
    throw e
  } finally {
    stopRemoteProgressSession(args.sessionId)
    clearRemoteProgressSession(args.sessionId)
    args.onFinally?.()
  }
  }
}
