import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import { buildFeishuRemoteSystemAppendix } from '../../src/shared/feishuPrompts'
import type { LarkCliRunner } from './larkCliRunner'
import type { FeishuConfirmManager } from './feishuConfirmManager'
import type { FeishuRemoteContext } from '../tools/types'
import { logFeishuCliEvent } from './feishuCliLogger'
import { createFeishuProgressAdapter, pickFeishuProgressConfig } from '../remote/feishuProgressAdapter'
import { FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { runImRemoteAgent } from '../remote/imRemoteAgent'
import type { WorkDirManager } from '../workDirManager'

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
  logFeishuCliEvent('info', 'feishu.agent.remote.start', {
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    workDir: ctx.workDir,
    confirmPolicy: ctx.feishuConfig.remoteConfirmPolicy
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
      createFeishuProgressAdapter({
        runner: ctx.runner,
        messageId: ctx.replyMessageId,
        getSessionId,
        config: ctx.feishuConfig,
        db: ctx.db
      }),
    buildSystemAppendix: ({ browserRemoteHint }) =>
      buildFeishuRemoteSystemAppendix({
        messageId: ctx.replyMessageId,
        confirmPolicy: ctx.feishuConfig.remoteConfirmPolicy,
        browserRemoteHint
      }),
    progressDefaults: FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG,
    progressConfig: pickFeishuProgressConfig(ctx.feishuConfig),
    toolChatExtras: {
      feishuConfig: ctx.feishuConfig,
      larkCliRunner: ctx.runner
    },
    logSensitiveBlocked: () => {
      logFeishuCliEvent('warn', 'feishu.agent.remote.sensitive_blocked', { sessionId: ctx.sessionId })
    },
    logDone: (result) => {
      if (!result.ok) return
      logFeishuCliEvent('info', 'feishu.agent.remote.done', {
        ok: result.ok,
        pendingConfirm: result.pendingConfirm,
        summaryLen: result.summary.length
      })
    },
    logError: (error) => {
      logFeishuCliEvent('error', 'feishu.agent.remote.error', { error, sessionId: ctx.sessionId })
    }
  })
}
