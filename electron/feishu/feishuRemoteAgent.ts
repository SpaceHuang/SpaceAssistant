import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { getMessages } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import type { BrowserConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import { buildFeishuRemoteSystemAppendix } from '../../src/shared/feishuPrompts'
import { resolveFeishuBrowserRemoteHint } from '../../src/shared/browserRemotePolicy'
import { buildSystemPrompt, getCachedMemoryContent } from '../projectMemory'
import { registerRunningRemoteAgent, unregisterRunningRemoteAgent } from './runningRemoteAgentRegistry'
import type { LarkCliRunner } from './larkCliRunner'
import type { FeishuConfirmManager } from './feishuConfirmManager'
import type { FeishuRemoteContext } from '../tools/types'
import { logFeishuCliEvent } from './feishuCliLogger'

export async function runFeishuRemoteAgent(ctx: {
  db: AppDatabase
  sessionId: string
  userMessage: string
  replyMessageId: string
  requestId: string
  feishuConfig: FeishuConfig
  workDir: string
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
  remoteContext: FeishuRemoteContext
}): Promise<{ summary: string; pendingConfirm: boolean; ok: boolean }> {
  const requestId = ctx.requestId
  const sender = ctx.getMainWebContents()
  const noopSender = {
    send: () => undefined
  } as unknown as WebContents

  const effectiveSender = sender ?? noopSender
  registerRunningRemoteAgent(ctx.sessionId)
  logFeishuCliEvent('info', 'feishu.agent.remote.start', {
    sessionId: ctx.sessionId,
    requestId,
    workDir: ctx.workDir,
    confirmPolicy: ctx.feishuConfig.remoteConfirmPolicy
  })

  try {
    const toolsConfig = ctx.getToolsConfig()
    const messages = getMessages(ctx.db, ctx.sessionId).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))

    const browserConfig = ctx.getBrowserConfig?.()
    const appendix = buildFeishuRemoteSystemAppendix({
      messageId: ctx.replyMessageId,
      confirmPolicy: ctx.feishuConfig.remoteConfirmPolicy,
      browserRemoteHint: resolveFeishuBrowserRemoteHint(
        browserConfig?.enabled,
        browserConfig?.allowRemoteSessions
      )
    })
    const memoryContent = getCachedMemoryContent()
    const system = buildSystemPrompt(appendix, memoryContent, true)

    const res = await runToolChatSession({
      sender: effectiveSender,
      requestId,
      sessionId: ctx.sessionId,
      model: ctx.getModel(),
      baseUrl: ctx.getBaseUrl(),
      messages,
      system,
      options: { maxTokens: 8192 },
      toolsConfig,
      browserConfig: ctx.getBrowserConfig?.(),
      wikiConfig: ctx.getWikiConfig?.(),
      workDir: ctx.workDir,
      userDataDir: ctx.userDataDir,
      getApiKey: ctx.getApiKey,
      appDb: ctx.db,
      feishuConfig: ctx.feishuConfig,
      larkCliRunner: ctx.runner,
      remoteContext: ctx.remoteContext
    })

    if (!res.ok) {
      const pending = res.error.includes('桌面') || res.error.includes('确认')
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
    unregisterRunningRemoteAgent(ctx.sessionId)
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
