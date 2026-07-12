import type { IncomingMessage } from '@wechatbot/wechatbot'

import type { WebContents } from 'electron'

import type { AppDatabase } from '../database'

import { getMessages } from '../database'

import { runToolChatSession } from '../toolChatLoop'

import { buildResolveWorkDirCallback, resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'

import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'

import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'

import type { WeChatConfig } from '../../src/shared/wechatTypes'

import { buildWeChatRemoteSystemAppendix } from '../../src/shared/wechatPrompts'

import { resolveFeishuBrowserRemoteHint } from '../../src/shared/browserRemotePolicy'

import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'

import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'

import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'

import type { WeChatConfirmManager } from './weChatConfirmManager'

import type { WeChatRemoteContext } from '../tools/types'

import type { WeChatBotService } from './weChatBotService'
import { logWeChatCliEvent } from './weChatCliLogger'

import { readAppLocale } from '../appIpc'

import {

  startRemoteProgressSession,

  stopRemoteProgressSession

} from '../remote/remoteProgressCoordinator'

import { createWeChatProgressAdapter, pickWeChatProgressConfig } from '../remote/weChatProgressAdapter'

import { clearRemoteProgressSession } from '../remote/remoteProgressStore'

import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'



export async function runWeChatRemoteAgent(ctx: {

  db: AppDatabase

  sessionId: string

  userMessage: string

  replyMessageId: string

  requestId: string

  wechatConfig: WeChatConfig

  workDir: string

  workDirManager: WorkDirManager

  userDataDir: string

  getMainWebContents: () => WebContents | null

  getApiKey: () => Promise<string | null>

  getBaseUrl: () => string

  getModel: () => string

  botService: WeChatBotService

  confirmManager: WeChatConfirmManager

  getToolsConfig: () => ToolsConfig

  getBrowserConfig?: () => BrowserConfig

  getWikiConfig?: () => WikiConfig

  getShellConfig?: () => ShellConfig

  remoteContext: WeChatRemoteContext

  inboundRaw: IncomingMessage

  userId: string

}): Promise<{ summary: string; pendingConfirm: boolean; ok: boolean }> {

  const requestId = ctx.requestId

  const sender = ctx.getMainWebContents()

  const noopSender = { send: () => undefined } as unknown as WebContents

  const effectiveSender = sender ?? noopSender

  logWeChatCliEvent('info', 'wechat.agent.remote.start', {

    sessionId: ctx.sessionId,

    messageId: ctx.replyMessageId,

    requestId

  })



  const adapter = createWeChatProgressAdapter({

    botService: ctx.botService,

    userId: ctx.userId,

    inboundRaw: ctx.inboundRaw,

    sessionId: ctx.sessionId,

    config: ctx.wechatConfig

  })

  startRemoteProgressSession(

    ctx.sessionId,

    adapter,

    pickWeChatProgressConfig(ctx.wechatConfig),

    DEFAULT_REMOTE_PROGRESS_CONFIG

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

      logWeChatCliEvent('warn', 'wechat.agent.remote.sensitive_blocked', { sessionId: ctx.sessionId })

      return { summary: SENSITIVE_WORKDIR_ERROR, pendingConfirm: false, ok: false }

    }

    const toolsConfig = ctx.getToolsConfig()

    const rawMessages = getMessages(ctx.db, ctx.sessionId)

    const built = buildClaudeToolChatMessages(rawMessages)

    const trimmed = trimClaudeToolChatMessages(built, MAX_CHAT_API_MESSAGES)

    const { messages } = ensureToolResultPairing(trimmed)



    const browserConfig = ctx.getBrowserConfig?.()

    const appendix = buildWeChatRemoteSystemAppendix({

      userId: ctx.userId,

      confirmPolicy: ctx.wechatConfig.remoteConfirmPolicy,

      browserRemoteHint: resolveFeishuBrowserRemoteHint(

        browserConfig?.enabled,

        browserConfig?.allowRemoteSessions

      )

    })



    const res = await runToolChatSession({

      sender: effectiveSender,

      requestId,

      sessionId: ctx.sessionId,

      model: ctx.getModel(),

      baseUrl: ctx.getBaseUrl(),

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

      getApiKey: ctx.getApiKey,

      appDb: ctx.db,

      wechatConfig: ctx.wechatConfig,

      remoteContext: ctx.remoteContext,

      locale: readAppLocale(ctx.db)

    })



    if (!res.ok) {

      const pending = res.error.includes('确认')

      logWeChatCliEvent('warn', 'wechat.agent.remote.done', {

        sessionId: ctx.sessionId,

        ok: false,

        pendingConfirm: pending,

        error: res.error

      })

      return { summary: res.error, pendingConfirm: pending, ok: false }

    }



    const text = extractTextFromContent(res.content)

    logWeChatCliEvent('info', 'wechat.agent.remote.done', {

      sessionId: ctx.sessionId,

      ok: true,

      summaryLen: text.length

    })

    return { summary: text || '任务已完成。', pendingConfirm: false, ok: true }

  } catch (e) {

    const error = e instanceof Error ? e.message : String(e)

    logWeChatCliEvent('error', 'wechat.agent.remote.error', { sessionId: ctx.sessionId, error })

    throw new Error(error)

  } finally {

    stopRemoteProgressSession(ctx.sessionId)

    clearRemoteProgressSession(ctx.sessionId)

    const b = ctx.botService.getBot()

    if (b?.stopTyping) void b.stopTyping(ctx.userId).catch(() => undefined)

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


