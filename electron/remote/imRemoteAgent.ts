import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { getMessages } from '../database'
import { runToolChatSession, type RunToolChatSessionArgs } from '../toolChatLoop'
import { buildResolveWorkDirCallback, resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import type { RemoteContext } from '../tools/types'
import { readAppLocale } from '../appIpc'
import { resolveLlmCredentialsForModel } from '../llmServiceResolver'
import {
  startRemoteProgressSession,
  stopRemoteProgressSession,
  type RemoteProgressAdapter
} from './remoteProgressCoordinator'
import { clearRemoteProgressSession } from './remoteProgressStore'
import type { RemoteProgressConfig } from '../../src/shared/remoteProgressTypes'
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

export type ImRemoteAgentResult = { summary: string; pendingConfirm: boolean; ok: boolean }

export async function runImRemoteAgent(args: {
  db: AppDatabase
  sessionId: string
  requestId: string
  workDir: string
  workDirManager: WorkDirManager
  userDataDir: string
  getMainWebContents: () => WebContents | null
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
  toolChatExtras?: Pick<RunToolChatSessionArgs, 'feishuConfig' | 'wechatConfig' | 'larkCliRunner'>
  onFinally?: () => void
  /** WeChat historically rethrows as `new Error(message)`. */
  rethrowAsError?: boolean
  logSensitiveBlocked?: () => void
  logDone?: (result: ImRemoteAgentResult & { error?: string }) => void
  logError?: (error: string) => void
}): Promise<ImRemoteAgentResult> {
  const requestId = args.requestId
  const sender = args.getMainWebContents()
  const noopSender = { send: () => undefined } as unknown as WebContents
  const effectiveSender = sender ?? noopSender

  const getOutboundSessionId = () => resolveRemoteOutboundSessionId(args.remoteContext, args.sessionId)
  const adapter = args.createProgressAdapter(getOutboundSessionId)
  startRemoteProgressSession(args.sessionId, adapter, args.progressConfig, args.progressDefaults)

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
    const built = buildClaudeToolChatMessages(rawMessages)
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
    const creds = await resolveLlmCredentialsForModel(args.db, routeModelName, {})
    const baseUrl = creds.baseUrl ?? args.getBaseUrl()
    const getApiKey = creds.error ? args.getApiKey : creds.getApiKey

    const res = await runToolChatSession({
      sender: effectiveSender,
      requestId,
      sessionId: args.sessionId,
      model: routeModelName,
      baseUrl,
      messages,
      system: appendix,
      options: { maxTokens: 8192 },
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
    })

    if (!res.ok) {
      const pending = res.error.includes('确认')
      const result = { summary: res.error, pendingConfirm: pending, ok: false as const }
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
