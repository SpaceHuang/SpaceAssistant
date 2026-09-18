import type { AppDatabase } from '../database'
import { getMessages, getConfigValue, getSession, createSession } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { buildResolveWorkDirCallback } from '../workDirManager'
import type { BrowserConfig, ShellConfig, ToolsConfig, ModelEntry } from '../../src/shared/domainTypes'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import { readAppLocale } from '../appIpc'
import { resolveLlmCredentialsForModel } from '../llmServiceResolver'
import { logHistoryOversizedToolResult } from '../oversizedToolResultLog'
import { buildFinalSystemPrompt } from '../llmSystemPrompt'
import { resolveTrustedTurnExecutionConfig } from '../turnExecutionConfig'
import type { WorkDirManager } from '../workDirManager'
import type { TurnRuntime } from '../turnRuntime'
import { executeRemoteTurn } from '../remote/turnExecutionAdapter'
import { createButlerSessionEvents } from './butlerSessionEvents'
import { ButlerAdmission } from './butlerAdmission'
import { deliverTaskResult, type ButlerDeliveryPorts } from './butlerDelivery'
import { getAutomationTask, insertAutomationTaskRun, updateAutomationTaskRun } from './taskStore'

/**
 * 管家执行链（P4）：定时 / 手动触发的 automation 任务 → 准入取票 → 会话创建（ownership=automation、
 * visibility=section，同一任务默认每次触发起新会话，控制上下文成本）→ turnRuntime 装配
 * （turnExecutionAdapter 模式）→ runToolChatSession({ lane: 'automation' })。
 * 门控按 P2 的 automation 规则裁决：只读放行，其余 confirm（无回答者 → 拒绝）。
 */

export const BUTLER_SYSTEM_APPENDIX = [
  '你是 SpaceAssistant 的后台管家（automation lane），由定时任务或用户手动触发，无人值守运行。',
  '本回合按任务指令完成检查、总结、提醒、报表等只读 / 汇报型工作。',
  '安全边界：无法获得人工确认——写文件、执行命令、发送消息等需要确认的操作会被自动拒绝；',
  '请优先使用只读工具完成任务，若被拒绝，请在最终回复中说明原因与已完成的部分。',
  '最终回复即任务结果汇报，请直接给出结论与关键数据，不要反问。'
].join('\n')

/** 审批线索包任务声明摘要上限（有界）：超长任务 prompt 只取前 N 字符。 */
export const APPROVAL_TASK_DIGEST_MAX_CHARS = 500

/**
 * 任务声明摘要（对比分析 §4-D，可信证据）：来自用户创建任务时的输入，
 * 供审批 Agent 判断「动作是否服务于任务」；折叠空白并截断，保持线索包有界。
 */
export function buildApprovalTaskDigest(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  return collapsed.length > APPROVAL_TASK_DIGEST_MAX_CHARS
    ? collapsed.slice(0, APPROVAL_TASK_DIGEST_MAX_CHARS)
    : collapsed
}

export type ButlerInvokerDeps = {
  db: AppDatabase
  turnRuntime?: TurnRuntime
  getWorkDir: () => string
  getUserDataPath: () => string
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getShellConfig?: () => ShellConfig | null
  workDirManager?: WorkDirManager
  /** 会话工作目录解析（主进程装配注入，与桌面链路同一来源）。 */
  resolveWorkDirForSession?: (sessionId: string) => string
  /** 活动工作目录 profile id（会话创建时绑定）。 */
  getActiveWorkDirProfileId?: () => string | undefined
  admission?: ButlerAdmission
  /** 投递端口（主进程装配注入；缺省 = IM 未接线走显式降级路径）。 */
  deliveryPorts?: ButlerDeliveryPorts
  /** 会话创建出口（主进程装配注入）：调度 / 手动触发的管家会话创建即回调，
   *  装配方经此把新会话推给渲染端会话列表（否则列表要重启才能看到，拉模式失效）。 */
  onSessionCreated?: (session: { id: string; name: string; ownership: string; visibility: string; workDirProfileId?: string }) => void
}

export type ButlerRunRequest = {
  trigger: 'manual' | 'schedule'
  /** 幂等键尾巴；缺省自动生成（手动触发传 requestId，调度器传 scheduledFor）。 */
  requestId?: string
  /** 定时触发对应的调度时刻（epoch ms）；手动触发为 0。 */
  scheduledFor?: number
}

export type ButlerRunOutcome =
  | { ok: true; runId: string; sessionId: string; summary: string }
  | { ok: false; runId?: string; error: string; admissionDenied?: 'hourly-limit' | 'queue-full' }

type ButlerTurnResult =
  | { ok: true; sessionId: string; summary: string; usageJson?: string }
  | { ok: false; error: string }

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

/** 执行一次管家任务（手动触发入口；调度器复用同一函数）。run 行先抢占（幂等），再准入，再执行。 */
export async function runButlerTask(deps: ButlerInvokerDeps, taskId: string, request: ButlerRunRequest): Promise<ButlerRunOutcome> {
  const db = deps.db
  const task = getAutomationTask(db, taskId)
  if (!task) return { ok: false, error: `任务不存在：${taskId}` }
  if (!deps.turnRuntime) return { ok: false, error: 'BUTLER_TURN_RUNTIME_REQUIRED' }

  const requestId = request.requestId ?? `butler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scheduledFor = request.scheduledFor ?? 0
  const claim = insertAutomationTaskRun(db, {
    taskId,
    clientId: `${taskId}:${request.trigger}:${requestId}`,
    trigger: request.trigger,
    scheduledFor
  })
  const runId = claim.runId ?? ''
  if (!claim.inserted || !runId) {
    return { ok: false, runId, error: '重复触发（幂等键已存在）' }
  }

  const admission = deps.admission ?? new ButlerAdmission()
  const ticket = await admission.acquire(requestId)
  if (!ticket.ok) {
    updateAutomationTaskRun(db, runId, { status: 'failed', error: `准入拒绝：${ticket.reason}` })
    return { ok: false, runId, error: `准入拒绝：${ticket.reason}`, admissionDenied: ticket.reason }
  }

  try {
    updateAutomationTaskRun(db, runId, { status: 'running' })

    // 会话创建（归属强制声明）+ 受信执行配置 + turn prepare
    const session = createSession(db, {
      name: `管家 · ${task.prompt.slice(0, 24)}`,
      ...(deps.getActiveWorkDirProfileId ? { workDirProfileId: deps.getActiveWorkDirProfileId() } : {}),
      ...(task.modelOverride ? { model: task.modelOverride } : {}),
    ownership: 'automation',
    visibility: 'section'
  })
  const sessionId = session.id
  // 会话创建即通知装配方（渲染端列表即时可见；依赖 P1 出口契约，Core 不接触窗口）
  deps.onSessionCreated?.({
    id: session.id,
    name: session.name,
    ownership: 'automation',
    visibility: 'section',
    ...(session.workDirProfileId ? { workDirProfileId: session.workDirProfileId } : {})
  })
    const executionConfig = await resolveTrustedTurnExecutionConfig(db, sessionId, 'automation')
    const prepared = deps.turnRuntime.prepare({
      mode: 'create-user',
      requestId,
      sessionId,
      input: { text: task.prompt },
      config: executionConfig
    })
    deps.turnRuntime.bindRequest(requestId, prepared.turnId)

    const turn = await executeRemoteTurn({
      runtime: deps.turnRuntime,
      prepared,
      requestId,
      run: () =>
        runButlerModelTurn(deps, {
          sessionId,
          requestId,
          turnId: prepared.turnId,
          llmServiceId: executionConfig?.llmServiceId,
          taskPrompt: task.prompt,
          assistantMessageId: prepared.assistantMessage.id
        })
    })

    if (!turn.ok) {
      updateAutomationTaskRun(db, runId, { status: 'failed', error: turn.error })
      return { ok: false, runId, error: turn.error }
    }
    // P5 投递薄分发：run 终态按任务配置送达；只有 completed 才投递（skipped 由调度侧守卫）。
    const delivery =
      task.deliveryPref === 'none'
        ? ({ status: 'none' as const } as const)
        : await deliverTaskResult({
            task: {
              id: task.id,
              name: task.name,
              deliveryPref: task.deliveryPref,
              ...(task.deliveryTarget ? { deliveryTarget: task.deliveryTarget } : {})
            },
            run: { runId, status: 'completed', sessionId: turn.sessionId, resultSummary: turn.summary },
            ports: deps.deliveryPorts ?? {}
          })
    updateAutomationTaskRun(db, runId, {
      status: 'completed',
      sessionId: turn.sessionId,
      resultSummary: turn.summary,
      usageJson: turn.usageJson,
      deliveryStatus: delivery.status,
      ...(delivery.status !== 'none' ? { deliveredAt: Date.now() } : {})
    })
    return { ok: true, runId, sessionId: turn.sessionId, summary: turn.summary }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 评审 P1-1：catch 块内的失败落库本身可能再抛（退出竞态下 db 已关闭），
    // 再抛会逃逸成 unhandled rejection——吞噬并记日志，保证向上返回结构化失败。
    try {
      updateAutomationTaskRun(db, runId, { status: 'failed', error: message })
    } catch {
      // 落库失败时 run 行保持 running；下一次启动恢复会标 interrupted
    }
    return { ok: false, runId, error: message }
  } finally {
    ticket.release()
  }
}

async function runButlerModelTurn(
  deps: ButlerInvokerDeps,
  args: { sessionId: string; requestId: string; turnId?: string; llmServiceId?: string; taskPrompt: string; assistantMessageId?: string }
): Promise<ButlerTurnResult> {
  const db = deps.db
  const session = getSession(db, args.sessionId)
  if (!session) return { ok: false, error: 'BUTLER_SESSION_MISSING' }

  const toolsConfig = deps.getToolsConfig()
  const rawMessages = getMessages(db, args.sessionId)
  const built = buildClaudeToolChatMessages(rawMessages, {
    workspaceRoot: deps.getWorkDir(),
    onOversizedToolResult: (info) => {
      logHistoryOversizedToolResult({
        sessionId: args.sessionId,
        toolUseId: info.toolUseId,
        originalLength: info.originalLength,
        compactedLength: info.compactedLength,
        source: 'butler-invoker'
      })
    }
  })
  const trimmed = trimClaudeToolChatMessages(built, MAX_CHAT_API_MESSAGES)
  const { messages } = ensureToolResultPairing(trimmed)

  let contextWindow: number | undefined
  try {
    const models = JSON.parse(getConfigValue(db, 'config.models') ?? '[]') as ModelEntry[]
    contextWindow = models.find((entry) => entry.name === session.model)?.maximumContext
  } catch { /* 无模型表时回退 undefined */ }

  const creds = await resolveLlmCredentialsForModel(db, session.model, {})
  if (creds.error) return { ok: false, error: `模型「${session.model}」不可用：${creds.error}` }

  const system = buildFinalSystemPrompt({
    system: BUTLER_SYSTEM_APPENDIX,
    memoryContent: null,
    memoryEnabled: false,
    locale: readAppLocale(db)
  })

  const butlerEvents = createButlerSessionEvents({
    workDir: deps.getWorkDir(),
    sessionId: args.sessionId,
    sessionCreatedAt: session.createdAt
  })
  const workDir = deps.resolveWorkDirForSession ? deps.resolveWorkDirForSession(args.sessionId) : deps.getWorkDir()

  const res = await runToolChatSession({
    requestId: args.requestId,
    sessionId: args.sessionId,
    turnId: args.turnId,
    // DIM3：统计维度以实际解析出的服务为准（评审 P1-2）；配置值仅作兜底
    llmServiceId: creds.serviceId || args.llmServiceId,
    lane: 'automation',
    // D 任务声明（可信证据）：随执行链进入审批线索包，供任务相关性判断
    approvalTaskDigest: buildApprovalTaskDigest(args.taskPrompt),
    model: session.model,
    contextWindow,
    baseUrl: creds.baseUrl,
    messages,
    system,
    options: { maxTokens: 8192 },
    toolsConfig,
    browserConfig: deps.getBrowserConfig?.(),
    shellConfig: deps.getShellConfig?.() ?? null,
    workDir,
    workDirManager: deps.workDirManager,
    resolveWorkDir: deps.workDirManager
      ? buildResolveWorkDirCallback(db, args.sessionId, deps.workDirManager, deps.getWorkDir())
      : undefined,
    userDataDir: deps.getUserDataPath(),
    getApiKey: creds.getApiKey,
    appDb: db,
    locale: readAppLocale(db),
    assistantMessageId: args.assistantMessageId,
    emitFactEvent: butlerEvents.emitFactEvent,
    emitSessionEvent: butlerEvents.emitSessionEvent,
    onFileTreeChanged: butlerEvents.onFileTreeChanged
  })

  if (!res.ok) return { ok: false, error: res.error }
  const summary = extractTextFromContent(res.content) || '任务已完成。'
  return {
    ok: true,
    sessionId: args.sessionId,
    summary,
    ...(res.usage ? { usageJson: JSON.stringify(res.usage) } : {})
  }
}
