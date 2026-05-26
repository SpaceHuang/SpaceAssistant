import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { getMessages } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import type { ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import { buildFeishuRemoteSystemAppendix } from '../../src/shared/feishuPrompts'
import { buildSystemPrompt, getCachedMemoryContent } from '../projectMemory'
import { registerRunningRemoteAgent, unregisterRunningRemoteAgent } from './runningRemoteAgentRegistry'
import type { LarkCliRunner } from './larkCliRunner'
import type { FeishuConfirmManager } from './feishuConfirmManager'
import { runPlanModeChat, resumePlanExecution } from '../plan/planOrchestrator'
import { readPlanStateForSession } from '../plan/planManager'
import type { FeishuRemoteContext } from '../tools/types'

export async function runFeishuRemoteAgent(ctx: {
  db: AppDatabase
  sessionId: string
  userMessage: string
  replyMessageId: string
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
  getWikiConfig?: () => WikiConfig
  remoteContext: FeishuRemoteContext
}): Promise<{ summary: string; pendingConfirm: boolean }> {
  const requestId = randomUUID()
  const sender = ctx.getMainWebContents()
  const noopSender = {
    send: () => undefined
  } as unknown as WebContents

  const effectiveSender = sender ?? noopSender
  registerRunningRemoteAgent(ctx.sessionId)

  try {
    const toolsConfig = ctx.getToolsConfig()
    const messages = getMessages(ctx.db, ctx.sessionId).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))

    const appendix = buildFeishuRemoteSystemAppendix({
      messageId: ctx.replyMessageId,
      confirmPolicy: ctx.feishuConfig.remoteConfirmPolicy
    })
    const memoryContent = getCachedMemoryContent()
    const system = buildSystemPrompt(appendix, memoryContent, true)

    const planDeps = {
      getApiKey: ctx.getApiKey,
      getWorkDir: () => ctx.workDir,
      getUserDataPath: () => ctx.userDataDir,
      getToolsConfig: () => ctx.getToolsConfig(),
      getWikiConfig: ctx.getWikiConfig,
      getAppDatabase: () => ctx.db
    }

    if (shouldUseRemotePlan(ctx.userMessage, ctx.feishuConfig)) {
      const planRes = await runPlanModeChat({
        sender: effectiveSender,
        requestId,
        sessionId: ctx.sessionId,
        model: ctx.getModel(),
        baseUrl: ctx.getBaseUrl(),
        messages,
        system,
        options: { maxTokens: 8192 },
        deps: planDeps
      })

      if (!planRes.ok) {
        return { summary: `计划生成失败：${planRes.error}`, pendingConfirm: false }
      }

      const planState = await readPlanStateForSession({ db: ctx.db, workDir: ctx.workDir, sessionId: ctx.sessionId })
      const stepCount = planState.plan?.stepsTotal ?? 0
      const summaryText = extractTextFromContent(planRes.content)
      const planSummary = `📋 执行计划（共 ${stepCount} 步）\n${summaryText.slice(0, 3500)}\n回复 Y 开始执行，N 取消（30 分钟内有效）`

      if (ctx.feishuConfig.remoteConfirmPolicy === 'feishu_confirm') {
        const decision = await ctx.confirmManager.requestConfirm(
          {
            kind: 'plan_execute',
            sessionId: ctx.sessionId,
            messageId: ctx.replyMessageId,
            chatId: ctx.remoteContext.chatId ?? ''
          },
          30 * 60_000
        )
        if (decision !== 'y') {
          return {
            summary: decision === 'timeout' ? '计划确认超时，已取消。' : '计划执行已取消。',
            pendingConfirm: false
          }
        }
      }

      let workerSummary = ''
      const maxSteps = 20
      for (let i = 0; i < maxSteps; i++) {
        const workerRes = await resumePlanExecution({
          sender: effectiveSender,
          requestId: randomUUID(),
          sessionId: ctx.sessionId,
          model: ctx.getModel(),
          baseUrl: ctx.getBaseUrl(),
          messages,
          system,
          options: { maxTokens: 8192 },
          deps: planDeps
        })
        if (!workerRes.ok) {
          workerSummary = `执行失败：${workerRes.error}`
          break
        }
        workerSummary = extractTextFromContent(workerRes.content) || '步骤完成'
        const state = await readPlanStateForSession({ db: ctx.db, workDir: ctx.workDir, sessionId: ctx.sessionId })
        const status = state.plan?.status
        if (status === 'completed' || status === 'cancelled') break
      }
      return { summary: workerSummary || planSummary, pendingConfirm: false }
    }

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
      return { summary: res.error, pendingConfirm: pending }
    }

    const text = extractTextFromContent(res.content)
    return { summary: text || '任务已完成。', pendingConfirm: false }
  } finally {
    unregisterRunningRemoteAgent(ctx.sessionId)
  }
}

function shouldUseRemotePlan(content: string, config: FeishuConfig): boolean {
  if (config.remotePlanMode === 'off') return false
  if (config.remotePlanMode === 'always') return true
  const keywords = config.remotePlanKeywords ?? []
  return keywords.some((k) => k.length > 0 && content.includes(k))
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
