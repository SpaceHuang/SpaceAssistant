import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { buildWeChatRemoteSystemAppendix } from '../../src/shared/wechatPrompts'
import type { WeChatConfirmManager } from './weChatConfirmManager'
import type { WeChatRemoteContext } from '../tools/types'
import type { WeChatBotService } from './weChatBotService'
import { logWeChatCliEvent } from './weChatCliLogger'
import { createWeChatProgressAdapter, pickWeChatProgressConfig } from '../remote/weChatProgressAdapter'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { runImRemoteAgent } from '../remote/imRemoteAgent'
import type { WorkDirManager } from '../workDirManager'

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
  logWeChatCliEvent('info', 'wechat.agent.remote.start', {
    sessionId: ctx.sessionId,
    messageId: ctx.replyMessageId,
    requestId: ctx.requestId
  })

  return runImRemoteAgent({
    db: ctx.db,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    workDir: ctx.workDir,
    workDirManager: ctx.workDirManager,
    userDataDir: ctx.userDataDir,
    getMainWebContents: ctx.getMainWebContents,
    getApiKey: ctx.getApiKey,
    getBaseUrl: ctx.getBaseUrl,
    getModel: ctx.getModel,
    remoteContext: ctx.remoteContext,
    getToolsConfig: ctx.getToolsConfig,
    getBrowserConfig: ctx.getBrowserConfig,
    getWikiConfig: ctx.getWikiConfig,
    getShellConfig: ctx.getShellConfig,
    createProgressAdapter: (getSessionId) =>
      createWeChatProgressAdapter({
        botService: ctx.botService,
        userId: ctx.userId,
        inboundRaw: ctx.inboundRaw,
        getSessionId,
        config: ctx.wechatConfig,
        db: ctx.db
      }),
    buildSystemAppendix: ({ browserRemoteHint }) =>
      buildWeChatRemoteSystemAppendix({
        userId: ctx.userId,
        confirmPolicy: ctx.wechatConfig.remoteConfirmPolicy,
        browserRemoteHint
      }),
    progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG,
    progressConfig: pickWeChatProgressConfig(ctx.wechatConfig),
    toolChatExtras: {
      wechatConfig: ctx.wechatConfig
    },
    rethrowAsError: true,
    onFinally: () => {
      const b = ctx.botService.getBot()
      if (b?.stopTyping) void b.stopTyping(ctx.userId).catch(() => undefined)
    },
    logSensitiveBlocked: () => {
      logWeChatCliEvent('warn', 'wechat.agent.remote.sensitive_blocked', { sessionId: ctx.sessionId })
    },
    logDone: (result) => {
      if (!result.ok) {
        logWeChatCliEvent('warn', 'wechat.agent.remote.done', {
          sessionId: ctx.sessionId,
          ok: false,
          pendingConfirm: result.pendingConfirm,
          error: result.error ?? result.summary
        })
        return
      }
      logWeChatCliEvent('info', 'wechat.agent.remote.done', {
        sessionId: ctx.sessionId,
        ok: true,
        summaryLen: result.summary.length
      })
    },
    logError: (error) => {
      logWeChatCliEvent('error', 'wechat.agent.remote.error', { sessionId: ctx.sessionId, error })
    }
  })
}
