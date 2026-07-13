import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { getMessages } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { buildResolveWorkDirCallback, resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import { buildFeishuRemoteSystemAppendix } from '../../src/shared/feishuPrompts'
import { resolveFeishuBrowserRemoteHint } from '../../src/shared/browserRemotePolicy'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import type { LarkCliRunner } from './larkCliRunner'
import type { FeishuConfirmManager } from './feishuConfirmManager'
import type { FeishuRemoteContext } from '../tools/types'
import { logFeishuCliEvent } from './feishuCliLogger'
import { readAppLocale } from '../appIpc'
import { resolveLlmCredentialsForModel } from '../llmServiceResolver'
import { startRemoteProgressSession, stopRemoteProgressSession } from '../remote/remoteProgressCoordinator'
import { createFeishuProgressAdapter, pickFeishuProgressConfig } from '../remote/feishuProgressAdapter'
import { clearRemoteProgressSession } from '../remote/remoteProgressStore'
import { FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { resolveRemoteOutboundSessionId } from '../remote/remoteSessionSwitchFollow'

export async function runFeishuRemoteAgent(ctx: {
  db: AppDatabase
  sessionId: string
  userMessage: string
  replyMessageId: string
  requestId: string
  feishuConfig: FeishuConfig
  workDir: string
  workDirManager: WorkDirManager
  userDataDir: string
  getMainWebContents: () => WebContents | null
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  runner: LarkCliRunner
  confirmManager: FeishuConfirmManager
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getWikiConfig?: () => WikiConfig
  getShellConfig?: () => ShellConfig
  remoteContext: FeishuRemoteContext
}): Promise<{ summary: string; pendingConfirm: boolean; ok: boolean }> {
  const requestId = ctx.requestId
  const sender = ctx.getMainWebContents()
  const noopSender = {
    send: () => undefined
  } as unknown as WebContents

  const effectiveSender = sender ?? noopSender
  logFeishuCliEvent('info', 'feishu.agent.remote.start', {
    sessionId: ctx.sessionId,
    requestId,
    workDir: ctx.workDir,
    confirmPolicy: ctx.feishuConfig.remoteConfirmPolicy
  })

  const getOutboundSessionId = () => resolveRemoteOutboundSessionId(ctx.remoteContext, ctx.sessionId)

  const adapter = createFeishuProgressAdapter({
    runner: ctx.runner,
    messageId: ctx.replyMessageId,
    getSessionId: getOutboundSessionId,
    config: ctx.feishuConfig,
    db: ctx.db
  })
  startRemoteProgressSession(
    ctx.sessionId,
    adapter,
    pickFeishuProgressConfig(ctx.feishuConfig),
    FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG
  )

  try {
    const resolved = resolveWorkDirForSession(
      ctx.db,
      ctx.sessionId,
      () => ctx.workDirManager.listProfiles(),
      () => ctx.workDirManager.getActiveProfileId(),
      () => ctx.workDirManager.getActiveWorkDir()
    )
    if (resolved?.isSensitive) {
      logFeishuCliEvent('warn', 'feishu.agent.remote.sensitive_blocked', { sessionId: ctx.sessionId })
      return { summary: SENSITIVE_WORKDIR_ERROR, pendingConfirm: false, ok: false }
    }

    const toolsConfig = ctx.getToolsConfig()
    const rawMessages = getMessages(ctx.db, ctx.sessionId)
    const built = buildClaudeToolChatMessages(rawMessages)
    const trimmed = trimClaudeToolChatMessages(built, MAX_CHAT_API_MESSAGES)
    const { messages } = ensureToolResultPairing(trimmed)

    const browserConfig = ctx.getBrowserConfig?.()
    const appendix = buildFeishuRemoteSystemAppendix({
      messageId: ctx.replyMessageId,
      confirmPolicy: ctx.feishuConfig.remoteConfirmPolicy,
      browserRemoteHint: resolveFeishuBrowserRemoteHint(
        browserConfig?.enabled,
        browserConfig?.allowRemoteSessions
      )
    })

    const routeModelName = ctx.getModel()
    const creds = await resolveLlmCredentialsForModel(ctx.db, routeModelName, {})
    const baseUrl = creds.baseUrl ?? ctx.getBaseUrl()
    const getApiKey = creds.error ? ctx.getApiKey : creds.getApiKey

    const res = await runToolChatSession({
      sender: effectiveSender,
      requestId,
      sessionId: ctx.sessionId,
      model: routeModelName,
      baseUrl: baseUrl,
      messages,
      system: appendix,
      options: { maxTokens: 8192 },
      toolsConfig,
      browserConfig: ctx.getBrowserConfig?.(),
      wikiConfig: ctx.getWikiConfig?.(),
      shellConfig: ctx.getShellConfig?.(),
      workDir: ctx.workDir,
      workDirManager: ctx.workDirManager,
      resolveWorkDir: buildResolveWorkDirCallback(ctx.db, ctx.sessionId, ctx.workDirManager, ctx.workDir),
      userDataDir: ctx.userDataDir,
      getApiKey: getApiKey,
      appDb: ctx.db,
      feishuConfig: ctx.feishuConfig,
      larkCliRunner: ctx.runner,
      remoteContext: ctx.remoteContext,
      locale: readAppLocale(ctx.db)
    })

    if (!res.ok) {
      const pending = res.error.includes('确认')
      return { summary: res.error, pendingConfirm: pending, ok: false }
    }

    const text = extractTextFromContent(res.content)
    const result = { summary: text || '任务已完成。', pendingConfirm: false, ok: true }
    logFeishuCliEvent('info', 'feishu.agent.remote.done', {
      ok: result.ok,
      pendingConfirm: result.pendingConfirm,
      summaryLen: result.summary.length
    })
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    logFeishuCliEvent('error', 'feishu.agent.remote.error', { error, sessionId: ctx.sessionId })
    throw e
  } finally {
    stopRemoteProgressSession(ctx.sessionId)
    clearRemoteProgressSession(ctx.sessionId)
  }
}

function extractTextFromContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') s += t
    }
  }
  return s.trim()
}
