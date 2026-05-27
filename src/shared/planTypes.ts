export type ChatMode = 'normal' | 'plan'

export const DEFAULT_CHAT_MODE: ChatMode = 'normal'

export type PlanStatus =
  | 'drafting'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'cancelled'

export interface PlanEnvSnapshot {
  gitHead: string | null
  timestamp: number
}

export interface PlanMeta {
  planId: string
  status: PlanStatus
  planFilePath: string
  currentStepIndex: number
  stepsTotal: number
  version: number
  createdAt: number
  approvedAt: number | null
  cancelledAt: number | null
  envSnapshot: PlanEnvSnapshot
}

export interface PlanVersionEntry {
  version: number
  createdAt: number
  approvalResult?: 'approved' | 'rejected'
}

export interface PlanAbortMeta {
  reason: string
  report: string
  createdAt: number
}

export type PlanStepStatus = 'completed' | 'failed' | 'blocked'

export interface PlanStepResult {
  stepIndex: number
  status: PlanStepStatus
  summary: string
  filesModified: string[]
  errors?: string[]
}

/** 计划执行驱动方式（会话级或全局配置，默认 auto） */
export type PlanExecutionMode = 'auto' | 'step_manual' | 'step_confirm'

export type PlanToolConfirmPolicy =
  | 'trust_plan'
  | 'trust_plan_all'
  | 'always_confirm'
  | 'confirm_high_risk'

export type PlanExecutionRunState =
  | 'idle'
  | 'running'
  | 'paused_user'
  | 'paused_blocked'
  | 'paused_confirm'
  | 'completed'
  | 'cancelled'

export interface PlanExecutionMeta {
  runState: PlanExecutionRunState
  executionMode: PlanExecutionMode
  toolConfirmPolicy: PlanToolConfirmPolicy
  startedAt: number | null
  pausedAt: number | null
  pauseReason?: string
  lastStepCompletedAt?: number
  /** 主进程 execution lock 持有者 requestId，防并发 */
  activeRunRequestId?: string | null
}

export const SESSION_META_PLAN = 'plan'
export const SESSION_META_PENDING_PLAN = 'pending_plan'
export const SESSION_META_DISPLAY_PLANS = 'display_plans'
export const SESSION_META_PLAN_DRAFTING = 'plan_drafting'
export const SESSION_META_PLAN_VERSIONS = 'plan_versions'
export const SESSION_META_PLAN_ABORT = 'plan_abort'
export const SESSION_META_PLAN_ABORT_DISMISSED = 'plan_abort_dismissed'
export const SESSION_META_PLAN_STEP_RESULTS = 'plan_step_results'
export const SESSION_META_PLAN_EXECUTION = 'plan_execution'

export interface PlanDisplayEntry {
  planId: string
  planFilePath: string
  title: string
  summaryOneLine?: string
  status: PlanStatus
  version: number
  createdAt: number
  approvedAt: number | null
  currentStepIndex: number
  stepsTotal: number
}

export type PlanPanelMainState = 'empty' | 'plans' | 'pending_approval'

export interface PlanApprovalSummary {
  title: string
  goalSummary: string
  stepCount: number
  fileHintCount: number
  acceptanceCriteria: string[]
  risks: string[]
  placeholderWarnings: string[]
}

export function isChatMode(value: unknown): value is ChatMode {
  return value === 'normal' || value === 'plan'
}

export function isPlanDrafting(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false
  return metadata[SESSION_META_PLAN_DRAFTING] === true
}

export function getPlanMeta(metadata: Record<string, unknown> | undefined): PlanMeta | undefined {
  if (!metadata) return undefined
  return normalizePlanMeta(metadata[SESSION_META_PLAN])
}

export function getPendingPlanMeta(metadata: Record<string, unknown> | undefined): PlanMeta | undefined {
  if (!metadata) return undefined
  const pending = normalizePlanMeta(metadata[SESSION_META_PENDING_PLAN])
  if (pending) return pending
  const plan = normalizePlanMeta(metadata[SESSION_META_PLAN])
  if (plan?.status === 'awaiting_approval') return plan
  return undefined
}

export function normalizePlanDisplayEntry(raw: unknown): PlanDisplayEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const planId = typeof o.planId === 'string' ? o.planId : ''
  const planFilePath = typeof o.planFilePath === 'string' ? o.planFilePath : ''
  const title = typeof o.title === 'string' ? o.title : ''
  const status = o.status
  if (!planId || !planFilePath || !title) return undefined
  if (
    status !== 'drafting' &&
    status !== 'awaiting_approval' &&
    status !== 'approved' &&
    status !== 'executing' &&
    status !== 'completed' &&
    status !== 'cancelled'
  ) {
    return undefined
  }
  return {
    planId,
    planFilePath,
    title,
    summaryOneLine: typeof o.summaryOneLine === 'string' ? o.summaryOneLine : undefined,
    status,
    version: typeof o.version === 'number' ? o.version : 1,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    approvedAt: typeof o.approvedAt === 'number' ? o.approvedAt : o.approvedAt === null ? null : null,
    currentStepIndex: typeof o.currentStepIndex === 'number' ? o.currentStepIndex : 0,
    stepsTotal: typeof o.stepsTotal === 'number' ? o.stepsTotal : 0
  }
}

export function getDisplayPlans(metadata: Record<string, unknown> | undefined): PlanDisplayEntry[] {
  if (!metadata) return []
  const raw = metadata[SESSION_META_DISPLAY_PLANS]
  if (!Array.isArray(raw)) return []
  return raw
    .map((v) => normalizePlanDisplayEntry(v))
    .filter((x): x is PlanDisplayEntry => x !== undefined)
}

export function isPlanAbortDismissed(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false
  return metadata[SESSION_META_PLAN_ABORT_DISMISSED] === true
}

export function derivePlanPanelMainState(metadata: Record<string, unknown> | undefined): PlanPanelMainState {
  const pending = getPendingPlanMeta(metadata)
  if (pending?.status === 'awaiting_approval') return 'pending_approval'
  if (getDisplayPlans(metadata).length > 0) return 'plans'
  return 'empty'
}

export function planMetaToDisplayEntry(
  plan: PlanMeta,
  extras?: { title?: string; summaryOneLine?: string }
): PlanDisplayEntry {
  return {
    planId: plan.planId,
    planFilePath: plan.planFilePath,
    title: extras?.title ?? '未命名计划',
    summaryOneLine: extras?.summaryOneLine,
    status: plan.status,
    version: plan.version,
    createdAt: plan.createdAt,
    approvedAt: plan.approvedAt,
    currentStepIndex: plan.currentStepIndex,
    stepsTotal: plan.stepsTotal
  }
}

export function normalizePlanMeta(raw: unknown): PlanMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const planId = typeof o.planId === 'string' ? o.planId : ''
  const status = o.status
  const planFilePath = typeof o.planFilePath === 'string' ? o.planFilePath : ''
  if (!planId || !planFilePath) return undefined
  if (
    status !== 'drafting' &&
    status !== 'awaiting_approval' &&
    status !== 'approved' &&
    status !== 'executing' &&
    status !== 'completed' &&
    status !== 'cancelled'
  ) {
    return undefined
  }
  const env = o.envSnapshot
  let envSnapshot: PlanEnvSnapshot = { gitHead: null, timestamp: Date.now() }
  if (env && typeof env === 'object') {
    const e = env as Record<string, unknown>
    envSnapshot = {
      gitHead: typeof e.gitHead === 'string' ? e.gitHead : e.gitHead === null ? null : null,
      timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now()
    }
  }
  return {
    planId,
    status,
    planFilePath,
    currentStepIndex: typeof o.currentStepIndex === 'number' ? o.currentStepIndex : 0,
    stepsTotal: typeof o.stepsTotal === 'number' ? o.stepsTotal : 0,
    version: typeof o.version === 'number' ? o.version : 1,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    approvedAt: typeof o.approvedAt === 'number' ? o.approvedAt : o.approvedAt === null ? null : null,
    cancelledAt: typeof o.cancelledAt === 'number' ? o.cancelledAt : o.cancelledAt === null ? null : null,
    envSnapshot
  }
}

export function getPlanVersions(metadata: Record<string, unknown> | undefined): PlanVersionEntry[] {
  if (!metadata) return []
  const raw = metadata[SESSION_META_PLAN_VERSIONS]
  if (!Array.isArray(raw)) return []
  return raw
    .map((v) => {
      if (!v || typeof v !== 'object') return null
      const o = v as Record<string, unknown>
      if (typeof o.version !== 'number' || typeof o.createdAt !== 'number') return null
      const entry: PlanVersionEntry = { version: o.version, createdAt: o.createdAt }
      if (o.approvalResult === 'approved' || o.approvalResult === 'rejected') {
        entry.approvalResult = o.approvalResult
      }
      return entry
    })
    .filter((x): x is PlanVersionEntry => x !== null)
}

export function getPlanAbort(metadata: Record<string, unknown> | undefined): PlanAbortMeta | undefined {
  if (!metadata) return undefined
  const raw = metadata[SESSION_META_PLAN_ABORT]
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.report !== 'string') return undefined
  return {
    reason: typeof o.reason === 'string' ? o.reason : '',
    report: o.report,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now()
  }
}

export function getPlanStepResults(metadata: Record<string, unknown> | undefined): PlanStepResult[] {
  if (!metadata) return []
  const raw = metadata[SESSION_META_PLAN_STEP_RESULTS]
  if (!Array.isArray(raw)) return []
  const out: PlanStepResult[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    if (typeof o.stepIndex !== 'number' || typeof o.summary !== 'string') continue
    const status = o.status
    if (status !== 'completed' && status !== 'failed' && status !== 'blocked') continue
    const entry: PlanStepResult = {
      stepIndex: o.stepIndex,
      status: status as PlanStepStatus,
      summary: o.summary,
      filesModified: Array.isArray(o.filesModified)
        ? o.filesModified.filter((f): f is string => typeof f === 'string')
        : []
    }
    if (Array.isArray(o.errors)) {
      entry.errors = o.errors.filter((e): e is string => typeof e === 'string')
    }
    out.push(entry)
  }
  return out
}

export function isPlanExplorationBlocked(status: PlanStatus | undefined): boolean {
  return status === 'drafting' || status === 'awaiting_approval'
}

export function isSessionPlanExplorationBlocked(metadata: Record<string, unknown> | undefined): boolean {
  if (isPlanDrafting(metadata)) return true
  const pending = getPendingPlanMeta(metadata)
  if (pending?.status === 'awaiting_approval') return true
  const plan = getPlanMeta(metadata)
  return plan ? isPlanExplorationBlocked(plan.status) : false
}

export function normalizePlanExecutionMeta(raw: unknown): PlanExecutionMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const runState = o.runState
  const executionMode = o.executionMode
  const toolConfirmPolicy = o.toolConfirmPolicy
  if (
    runState !== 'idle' &&
    runState !== 'running' &&
    runState !== 'paused_user' &&
    runState !== 'paused_blocked' &&
    runState !== 'paused_confirm' &&
    runState !== 'completed' &&
    runState !== 'cancelled'
  ) {
    return undefined
  }
  if (executionMode !== 'auto' && executionMode !== 'step_manual' && executionMode !== 'step_confirm') {
    return undefined
  }
  if (
    toolConfirmPolicy !== 'trust_plan' &&
    toolConfirmPolicy !== 'trust_plan_all' &&
    toolConfirmPolicy !== 'always_confirm' &&
    toolConfirmPolicy !== 'confirm_high_risk'
  ) {
    return undefined
  }
  return {
    runState,
    executionMode,
    toolConfirmPolicy,
    startedAt: typeof o.startedAt === 'number' ? o.startedAt : o.startedAt === null ? null : null,
    pausedAt: typeof o.pausedAt === 'number' ? o.pausedAt : o.pausedAt === null ? null : null,
    pauseReason: typeof o.pauseReason === 'string' ? o.pauseReason : undefined,
    lastStepCompletedAt: typeof o.lastStepCompletedAt === 'number' ? o.lastStepCompletedAt : undefined,
    activeRunRequestId:
      typeof o.activeRunRequestId === 'string'
        ? o.activeRunRequestId
        : o.activeRunRequestId === null
          ? null
          : undefined
  }
}

export function getPlanExecutionMeta(metadata: Record<string, unknown> | undefined): PlanExecutionMeta | undefined {
  if (!metadata) return undefined
  return normalizePlanExecutionMeta(metadata[SESSION_META_PLAN_EXECUTION])
}

/** 应用重启后：running 视为 paused_blocked（不 silently 续跑） */
export function reconcilePlanExecutionOnLoad(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const exec = getPlanExecutionMeta(metadata)
  if (!exec || exec.runState !== 'running') return metadata
  return {
    ...metadata,
    [SESSION_META_PLAN_EXECUTION]: {
      ...exec,
      runState: 'paused_blocked' as const,
      pausedAt: Date.now(),
      pauseReason: '执行已中断，是否继续？',
      activeRunRequestId: null
    }
  }
}
