import type { WebContents } from 'electron'
import type { ToolsConfig, WikiConfig, PlanConfig } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { getSession } from '../database'
import { runToolChatSession, type ClaudeContentBlockMessage } from '../toolChatLoop'
import { normalizeAnthropicMessageUsage } from '../anthropicUsageNormalize'
import { filterBuiltinToolsForPlanPhase } from '../../src/shared/planToolsFilter'
import { getPlanMeta, getPendingPlanMeta, isPlanDrafting, getDisplayPlans, getPlanExecutionMeta, type PlanMeta } from '../../src/shared/planTypes'
import { extractPlanMarkersFromAssistantContent, extractPlanMarkersFromText } from './planDocExtract'
import type { PlanReadResult } from '../../src/shared/api'
import {
  applyPlanAbortToSession,
  applyPlanDocToSession,
  startPlanExecutionInSession,
  readPlanFile,
  readPlanStateForSession,
  saveSessionMetadata,
  mergePlanMetadata,
  completePlanInSession,
  appendStepResult,
  advancePlanStep,
  cancelPlanInSession,
  syncDisplayPlanStatus
} from './planManager'
import { buildPlanApprovalSummary, parsePlanMarkdown } from './planParser'
import { buildPlanExplorationSystemPrompt, buildPlanRevisionSystemPrompt, buildPlanWorkerSystemPrompt } from './planPrompts'
import {
  acquireSessionExecutionLock,
  releaseSessionExecutionLock,
  PlanExecutionLockError
} from './planExecutionLock'
import {
  clearPlanPauseRequest,
  isPlanPauseRequested,
  markPlanRunState,
  readPlanExecutionMetaFromDb,
  requestPlanPause,
  updatePlanExecutionMeta
} from './planExecutionState'
import { consumePlanConfirmFailure } from './planConfirmFailure'
import { clearProvenanceContext } from './runScriptProvenance'
import { randomUUID } from 'crypto'

export type PlanOrchestratorDeps = {
  getApiKey: () => Promise<string | null>
  getWorkDir: () => string
  getUserDataPath: () => string
  getToolsConfig: () => ToolsConfig
  getWikiConfig?: () => WikiConfig
  getAppDatabase: () => AppDatabase
  getPlanConfig: () => PlanConfig
}

function emitPlanStateChanged(
  sender: WebContents,
  sessionId: string,
  extra?: { clearStaleToolConfirms?: boolean; activeRunRequestId?: string | null }
): void {
  sender.send('plan:state-changed', { sessionId, ...extra })
}

function emitPlanStepCompleted(
  sender: WebContents,
  payload: { sessionId: string; stepIndex: number; stepsTotal: number; summary: string; requestId: string }
): void {
  sender.send('plan:step-completed', payload)
}

function emitPlanStepStarted(
  sender: WebContents,
  payload: { sessionId: string; stepIndex: number; stepsTotal: number; requestId: string }
): void {
  sender.send('plan:step-started', payload)
}

async function emitPlanApprovalReady(
  sender: WebContents,
  deps: PlanOrchestratorDeps,
  sessionId: string
): Promise<PlanReadResult> {
  const planState = await readPlanStateForSession({
    db: deps.getAppDatabase(),
    workDir: deps.getWorkDir(),
    sessionId
  })
  sender.send('plan:approval-ready', { sessionId, planState })
  return planState
}

function extractTextFromContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') s += t
    }
  }
  return s
}

function combineSystem(base: string | undefined, extra: string): string {
  if (base?.trim()) return `${base.trim()}\n\n${extra}`
  return extra
}

export async function runPlanModeChat(args: {
  sender: WebContents
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  deps: PlanOrchestratorDeps
  revisionFeedback?: string
}): Promise<{ ok: true; content: unknown[]; stopReason: string; usage?: ReturnType<typeof normalizeAnthropicMessageUsage> } | { ok: false; error: string }> {
  const { deps } = args
  const db = deps.getAppDatabase()
  const session = getSession(db, args.sessionId)
  if (!session) return { ok: false, error: 'Session not found' }

  const planMeta = getPlanMeta(session.metadata)
  if (planMeta?.status === 'executing' || planMeta?.status === 'approved') {
    return await runWorkerExecution({
      ...args,
      deps: args.deps,
      planMeta
    })
  }

  return await runPlanningPhase(args)
}

async function runPlanningPhase(args: {
  sender: WebContents
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  deps: PlanOrchestratorDeps
  revisionFeedback?: string
}): Promise<{ ok: true; content: unknown[]; stopReason: string; usage?: ReturnType<typeof normalizeAnthropicMessageUsage> } | { ok: false; error: string }> {
  const { deps } = args
  const db = deps.getAppDatabase()
  const workDir = deps.getWorkDir()
  const toolsConfig = deps.getToolsConfig()
  const wikiConfig = deps.getWikiConfig?.()
  const session = getSession(db, args.sessionId)
  const existingPlan = session
    ? getPendingPlanMeta(session.metadata) ?? getPlanMeta(session.metadata)
    : undefined

  if (session && !existingPlan && !isPlanDrafting(session.metadata)) {
    const metadata = mergePlanMetadata(session.metadata, {
      plan_drafting: true,
      plan_abort: null
    })
    saveSessionMetadata(db, args.sessionId, metadata)
    emitPlanStateChanged(args.sender, args.sessionId)
  }

  const planPrompt = args.revisionFeedback
    ? buildPlanRevisionSystemPrompt(args.revisionFeedback)
    : buildPlanExplorationSystemPrompt()

  const res = await runToolChatSession({
    sender: args.sender,
    requestId: args.requestId,
    sessionId: args.sessionId,
    model: args.model,
    baseUrl: args.baseUrl,
    messages: args.messages,
    system: combineSystem(args.system, planPrompt),
    options: args.options,
    toolsConfig,
    wikiConfig,
    workDir,
    userDataDir: deps.getUserDataPath(),
    getApiKey: deps.getApiKey,
    appDb: db,
    planToolPhase: 'planning',
    toolsOverride: filterBuiltinToolsForPlanPhase(toolsConfig, 'planning') as unknown[]
  })

  if (!res.ok) return res

  const content = res.content
  const marker = extractPlanMarkersFromAssistantContent(content)

  if (marker.kind === 'plan-abort') {
    await applyPlanAbortToSession({
      db,
      sessionId: args.sessionId,
      report: marker.content,
      reason: 'exploration_abort'
    })
    emitPlanStateChanged(args.sender, args.sessionId)
    return { ok: true, content, stopReason: res.stopReason, usage: res.usage }
  }

  if (marker.kind === 'plan-doc') {
    await applyPlanDocToSession({
      db,
      sessionId: args.sessionId,
      workDir,
      planDocMarkdown: marker.content,
      existingPlan: existingPlan?.planFilePath ? existingPlan : undefined
    })
    emitPlanStateChanged(args.sender, args.sessionId)
    await emitPlanApprovalReady(args.sender, deps, args.sessionId)
    return { ok: true, content, stopReason: res.stopReason, usage: res.usage }
  }

  const text = extractTextFromContent(content)
  const fallback = extractPlanMarkersFromText(text)
  if (fallback.kind === 'plan-doc') {
    await applyPlanDocToSession({
      db,
      sessionId: args.sessionId,
      workDir,
      planDocMarkdown: fallback.content,
      existingPlan: existingPlan?.planFilePath ? existingPlan : undefined
    })
    emitPlanStateChanged(args.sender, args.sessionId)
    await emitPlanApprovalReady(args.sender, deps, args.sessionId)
  } else if (fallback.kind === 'plan-abort') {
    await applyPlanAbortToSession({
      db,
      sessionId: args.sessionId,
      report: fallback.content
    })
    emitPlanStateChanged(args.sender, args.sessionId)
  }

  return { ok: true, content, stopReason: res.stopReason, usage: res.usage }
}

async function runWorkerExecution(args: {
  sender: WebContents
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  deps: PlanOrchestratorDeps
  planMeta: PlanMeta
}): Promise<{ ok: true; content: unknown[]; stopReason: string; usage?: ReturnType<typeof normalizeAnthropicMessageUsage> } | { ok: false; error: string }> {
  const { deps } = args
  const db = deps.getAppDatabase()
  const workDir = deps.getWorkDir()
  const toolsConfig = deps.getToolsConfig()
  const wikiConfig = deps.getWikiConfig?.()
  let planMeta = args.planMeta

  if (planMeta.status === 'approved') {
    planMeta = await startPlanExecutionInSession({ db, sessionId: args.sessionId, workDir })
  }

  const sessionBeforeStep = getSession(db, args.sessionId)
  if (getPlanMeta(sessionBeforeStep?.metadata)?.status === 'cancelled') {
    emitPlanStateChanged(args.sender, args.sessionId)
    return { ok: true, content: [{ type: 'text', text: '计划已取消。' }], stopReason: 'end_turn' }
  }

  const raw = await readPlanFile(workDir, planMeta.planFilePath)
  const parsed = parsePlanMarkdown(raw)
  const steps = parsed.steps
  const stepsTotal = steps.length || planMeta.stepsTotal
  let stepIndex = planMeta.currentStepIndex

  if (stepIndex >= stepsTotal) {
    await completePlanInSession({ db, sessionId: args.sessionId })
    emitPlanStateChanged(args.sender, args.sessionId)
    return { ok: true, content: [{ type: 'text', text: '计划已全部执行完成。' }], stopReason: 'end_turn' }
  }

  const stepText = steps[stepIndex] ?? `步骤 ${stepIndex + 1}`
  const workerSystem = buildPlanWorkerSystemPrompt({
    planTitle: parsed.title,
    stepIndex,
    stepsTotal,
    stepText
  })

  const res = await runToolChatSession({
    sender: args.sender,
    requestId: args.requestId,
    sessionId: args.sessionId,
    model: args.model,
    baseUrl: args.baseUrl,
    messages: args.messages,
    system: combineSystem(args.system, workerSystem),
    options: args.options,
    toolsConfig,
    wikiConfig,
    workDir,
    userDataDir: deps.getUserDataPath(),
    getApiKey: deps.getApiKey,
    appDb: db,
    planToolPhase: 'implementation',
    planConfig: deps.getPlanConfig()
  })

  clearProvenanceContext(args.requestId)

  const confirmFailure = consumePlanConfirmFailure(args.requestId)
  if (confirmFailure) {
    markPlanRunState(db, args.sessionId, 'paused_blocked', {
      pauseReason: confirmFailure,
      activeRunRequestId: null
    })
    emitPlanStateChanged(args.sender, args.sessionId, { clearStaleToolConfirms: true })
    return { ok: false, error: confirmFailure }
  }

  if (!res.ok) return res

  const summary = extractTextFromContent(res.content as unknown[]).slice(0, 500) || '步骤已完成'
  const session = getSession(db, args.sessionId)
  if (session && getPlanMeta(session.metadata)?.status !== 'cancelled') {
    let metadata = appendStepResult(session.metadata, {
      stepIndex,
      status: 'completed',
      summary,
      filesModified: []
    })
    const nextIndex = stepIndex + 1
    metadata = advancePlanStep(metadata, nextIndex)
    const plan = getPlanMeta(metadata)
    if (plan) {
      const done = nextIndex >= stepsTotal
      let displayPlans = getDisplayPlans(metadata)
      displayPlans = syncDisplayPlanStatus(displayPlans, plan.planId, done ? 'completed' : 'executing', {
        currentStepIndex: nextIndex,
        stepsTotal
      })
      metadata = mergePlanMetadata(metadata, {
        plan: {
          ...plan,
          currentStepIndex: nextIndex,
          stepsTotal,
          status: done ? 'completed' : 'executing'
        },
        display_plans: displayPlans
      })
    }
    saveSessionMetadata(db, args.sessionId, metadata)
    emitPlanStateChanged(args.sender, args.sessionId)
  }

  return { ok: true, content: res.content, stopReason: res.stopReason, usage: res.usage }
}

export type PlanRunResult =
  | {
      ok: true
      completed: boolean
      paused: boolean
      pauseReason?: string
      lastContent?: unknown[]
      usage?: ReturnType<typeof normalizeAnthropicMessageUsage>
    }
  | { ok: false; error: string }

export async function runPlanUntilDone(args: {
  sender: WebContents
  loopRequestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  deps: PlanOrchestratorDeps
}): Promise<PlanRunResult> {
  const { deps, sender, sessionId } = args
  const db = deps.getAppDatabase()

  try {
    acquireSessionExecutionLock(sessionId, args.loopRequestId)
  } catch (e) {
    if (e instanceof PlanExecutionLockError) {
      return { ok: false, error: e.message }
    }
    throw e
  }

  clearPlanPauseRequest(sessionId)
  markPlanRunState(db, sessionId, 'running', {
    startedAt: Date.now(),
    activeRunRequestId: args.loopRequestId
  })
  emitPlanStateChanged(sender, sessionId)

  let messages = [...args.messages]
  let lastContent: unknown[] | undefined
  let lastUsage: ReturnType<typeof normalizeAnthropicMessageUsage> | undefined

  try {
    const maxSteps = 50
    for (let i = 0; i < maxSteps; i++) {
      if (isPlanPauseRequested(sessionId)) {
        clearPlanPauseRequest(sessionId)
        markPlanRunState(db, sessionId, 'paused_user', { activeRunRequestId: null })
        emitPlanStateChanged(sender, sessionId, { clearStaleToolConfirms: true })
        return { ok: true, completed: false, paused: true, pauseReason: '用户已暂停执行', lastContent, usage: lastUsage }
      }

      const session = getSession(db, sessionId)
      const planMeta = session ? getPlanMeta(session.metadata) : undefined
      if (!planMeta || planMeta.status === 'completed' || planMeta.status === 'cancelled') {
        const completed = planMeta?.status === 'completed'
        if (completed) {
          markPlanRunState(db, sessionId, 'completed', { activeRunRequestId: null })
        }
        emitPlanStateChanged(sender, sessionId)
        return { ok: true, completed: Boolean(completed), paused: false, lastContent, usage: lastUsage }
      }

      const execMeta = readPlanExecutionMetaFromDb(db, sessionId)
      const executionMode = execMeta?.executionMode ?? deps.getPlanConfig().executionMode

      const raw = await readPlanFile(deps.getWorkDir(), planMeta.planFilePath)
      const parsed = parsePlanMarkdown(raw)
      const stepsTotal = parsed.steps.length || planMeta.stepsTotal
      const stepIndex = planMeta.currentStepIndex

      if (stepIndex >= stepsTotal) {
        await completePlanInSession({ db, sessionId })
        markPlanRunState(db, sessionId, 'completed', { activeRunRequestId: null })
        emitPlanStateChanged(sender, sessionId)
        return { ok: true, completed: true, paused: false, lastContent, usage: lastUsage }
      }

      const stepRequestId = randomUUID()
      updatePlanExecutionMeta(db, sessionId, { activeRunRequestId: stepRequestId })
      emitPlanStepStarted(sender, { sessionId, stepIndex, stepsTotal, requestId: stepRequestId })

      const res = await runWorkerExecution({
        sender,
        requestId: stepRequestId,
        sessionId,
        model: args.model,
        baseUrl: args.baseUrl,
        messages,
        system: args.system,
        options: args.options,
        deps,
        planMeta
      })

      if (!res.ok) {
        const execAfter = readPlanExecutionMetaFromDb(db, sessionId)
        if (execAfter?.runState !== 'paused_blocked') {
          markPlanRunState(db, sessionId, 'paused_blocked', {
            pauseReason: res.error,
            activeRunRequestId: null
          })
        }
        emitPlanStateChanged(sender, sessionId, { clearStaleToolConfirms: true })
        return { ok: true, completed: false, paused: true, pauseReason: res.error, lastContent, usage: lastUsage }
      }

      lastContent = res.content
      lastUsage = res.usage
      messages = [...messages, { role: 'assistant', content: res.content }]

      const summary = extractTextFromContent(res.content as unknown[]).slice(0, 500) || '步骤已完成'
      emitPlanStepCompleted(sender, {
        sessionId,
        stepIndex,
        stepsTotal,
        summary,
        requestId: stepRequestId
      })
      updatePlanExecutionMeta(db, sessionId, { lastStepCompletedAt: Date.now() })
      emitPlanStateChanged(sender, sessionId, {
        clearStaleToolConfirms: true,
        activeRunRequestId: stepRequestId
      })

      const sessionAfter = getSession(db, sessionId)
      const planAfter = sessionAfter ? getPlanMeta(sessionAfter.metadata) : undefined
      if (planAfter?.status === 'completed' || planAfter?.status === 'cancelled') {
        const completed = planAfter.status === 'completed'
        if (completed) {
          markPlanRunState(db, sessionId, 'completed', { activeRunRequestId: null })
        }
        emitPlanStateChanged(sender, sessionId)
        return { ok: true, completed, paused: false, lastContent, usage: lastUsage }
      }

      if (executionMode === 'step_manual') {
        markPlanRunState(db, sessionId, 'idle', { activeRunRequestId: null })
        emitPlanStateChanged(sender, sessionId, { clearStaleToolConfirms: true })
        return { ok: true, completed: false, paused: false, lastContent, usage: lastUsage }
      }

      if (isPlanPauseRequested(sessionId)) {
        clearPlanPauseRequest(sessionId)
        markPlanRunState(db, sessionId, 'paused_user', { activeRunRequestId: null })
        emitPlanStateChanged(sender, sessionId, { clearStaleToolConfirms: true })
        return { ok: true, completed: false, paused: true, pauseReason: '用户已暂停执行', lastContent, usage: lastUsage }
      }
    }

    markPlanRunState(db, sessionId, 'paused_blocked', {
      pauseReason: '超过最大步数限制',
      activeRunRequestId: null
    })
    emitPlanStateChanged(sender, sessionId)
    return {
      ok: true,
      completed: false,
      paused: true,
      pauseReason: '超过最大步数限制',
      lastContent,
      usage: lastUsage
    }
  } finally {
    releaseSessionExecutionLock(sessionId, args.loopRequestId)
  }
}

export { requestPlanPause }

export async function resumePlanExecution(args: {
  sender: WebContents
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  deps: PlanOrchestratorDeps
}): Promise<{ ok: true; content: unknown[]; stopReason: string; usage?: ReturnType<typeof normalizeAnthropicMessageUsage> } | { ok: false; error: string }> {
  const { deps } = args
  const db = deps.getAppDatabase()
  const session = getSession(db, args.sessionId)
  const planMeta = session ? getPlanMeta(session.metadata) : undefined
  if (!planMeta || (planMeta.status !== 'executing' && planMeta.status !== 'approved')) {
    return { ok: false, error: 'No executable plan to resume' }
  }
  return await runWorkerExecution({ ...args, deps: args.deps, planMeta })
}

export async function startPlanAfterReject(args: {
  sender: WebContents
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  deps: PlanOrchestratorDeps
  feedback: string
}): Promise<{ ok: true; content: unknown[]; stopReason: string; usage?: ReturnType<typeof normalizeAnthropicMessageUsage> } | { ok: false; error: string }> {
  return await runPlanningPhase({ ...args, revisionFeedback: args.feedback })
}

export { buildPlanApprovalSummary, readPlanFile }

// re-export for IPC
export async function readPlanSummaryForSession(workDir: string, planMeta: PlanMeta) {
  const raw = await readPlanFile(workDir, planMeta.planFilePath)
  return { raw, summary: buildPlanApprovalSummary(raw) }
}
