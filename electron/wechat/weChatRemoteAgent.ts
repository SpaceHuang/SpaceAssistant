import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { AppDatabase } from '../database'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { buildWeChatRemoteSystemAppendix } from '../../src/shared/wechatPrompts'
import type { WeChatImChannel } from './weChatImChannel'
import type { WeChatRemoteContext } from '../tools/types'
import type { WeChatBotService } from './weChatBotService'
import { logWeChatCliEvent } from './weChatCliLogger'
import { createWeChatProgressAdapter, pickWeChatProgressConfig } from '../remote/weChatProgressAdapter'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { runImRemoteAgent } from '../remote/imRemoteAgent'
import type { WorkDirManager } from '../workDirManager'
import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'

export async function runWeChatRemoteAgent(ctx: {
  db: AppDatabase
  sessionId: string
  userMessage: string
  replyMessageId: string
  requestId: string
  /** 本回合真实 Turn ID（C17）：供用量统计落库。 */
  turnId?: string
  /** 冻结执行配置里的 LLM 服务 ID（DIM3）。 */
  llmServiceId?: string
  wechatConfig: WeChatConfig
  workDir: string
  workDirManager: WorkDirManager
  userDataDir: string
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  botService: WeChatBotService
  imChannel: WeChatImChannel
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getWikiConfig?: () => WikiConfig
  getShellConfig?: () => ShellConfig
  remoteContext: WeChatRemoteContext
  emitFactEvent?: (event: AssistantFactEvent) => void
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
    turnId: ctx.turnId,
    llmServiceId: ctx.llmServiceId,
    workDir: ctx.workDir,
    workDirManager: ctx.workDirManager,
    userDataDir: ctx.userDataDir,
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
    ,emitFactEvent: ctx.emitFactEvent
  })
}
