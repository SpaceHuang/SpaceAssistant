import type { AgentReasoningEffort } from './agent/invocation'

/**
 * 管家任务共享类型（P6 IPC 面）：主进程 taskStore 与渲染端设置页共用。
 */

export type AutomationTaskSchedule =
  | { kind: 'interval'; intervalMinutes: number }
  | { kind: 'daily'; time: string }
  /** 一次性：给定具体时刻（epoch ms）到点执行一次，之后不再执行（执行后任务停用）。 */
  | { kind: 'once'; at: number }

export type AutomationDeliveryPref = 'desktop' | 'feishu' | 'wechat' | 'none'

export type AutomationTask = {
  id: string
  name: string
  schedule: AutomationTaskSchedule
  prompt: string
  deliveryPref: AutomationDeliveryPref
  deliveryTarget?: string
  /** 兼容旧任务：缺省表示准入后捕获活动 Profile。 */
  workDir?: string
  workDirs?: string[]
  /** 旧任务迁移为 0；通过新预检创建/编辑/启用后为 1。 */
  preflightVersion?: 0 | 1
  targetBindingsJson?: string | null
  taskRevision?: number
  scheduleGeneration?: number
  modelId?: string
  modelServiceId?: string
  reasoningEffort?: AgentReasoningEffort
  /** provider-facing 模型名称；不是 ModelEntry.id。 */
  modelOverride?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
}

export type AutomationTaskInput = {
  name: string
  schedule: AutomationTaskSchedule
  prompt: string
  deliveryPref: AutomationDeliveryPref
  deliveryTarget?: string
  workDir?: string
  workDirs?: string[]
  modelId?: string
  modelServiceId?: string
  reasoningEffort?: AgentReasoningEffort
  /** provider-facing 模型名称；不是 ModelEntry.id。 */
  modelOverride?: string
  enabled?: boolean
  nextRunAt?: number
}

export type AutomationTaskRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'interrupted'

export type AutomationTaskRunTrigger = 'schedule' | 'manual'

export type AutomationTaskRun = {
  id: string
  taskId: string
  clientId: string
  trigger: AutomationTaskRunTrigger
  scheduledFor: number
  status: AutomationTaskRunStatus
  error?: string
  sessionId?: string
  resultSummary?: string
  usageJson?: string
  configSnapshot?: AutomationTaskRunConfigSnapshot
  runPhase?: 'queued-before-start' | 'running' | 'terminal' | 'legacy-unknown'
  taskRevision?: number
  scheduleGeneration?: number
  slotAt?: number
  deliveryStatus: 'pending' | 'delivered' | 'failed-degraded' | 'delivery-uncertain' | 'none'
  deliveredAt?: number
  createdAt: number
  updatedAt: number
}

export type AutomationTaskRunConfigSnapshot = {
  resolutionStatus: 'resolved' | 'failed'
  prompt?: string
  schedule?: AutomationTaskSchedule
  taskRevision?: number
  workDir?: string
  workDirs?: string[]
  preflightVersion?: 0 | 1
  targetSelections?: TargetSelection[]
  workDirSource?: 'task' | 'legacy-profile'
  modelId?: string
  providerModelName?: string
  serviceId?: string
  routeIdentity?: string
  requestedEffort?: AgentReasoningEffort
  effectiveEffort?: AgentReasoningEffort
  reasoningDegraded?: boolean
  error?: string
}

export type TargetBinding =
  | { kind: 'exact'; path: string; targetType: 'file' | 'directory'; rawText: string; resolverVersion: number; rootsDigest: string; taskRevision: number }
  | { kind: 'collection'; directory: string; selector: '*.csv' | '*.tsv' | 'all'; sort: 'canonical-path'; rawText: string; resolverVersion: number; rootsDigest: string; taskRevision: number }
  | { kind: 'output'; path: string; ancestor: string; relativeSuffix: string; expectedType: 'file' | 'directory'; rawText: string; resolverVersion: number; rootsDigest: string; taskRevision: number }

export type TargetSelection = TargetBinding

export type PreflightIssue = {
  code: string
  messageKey: string
  messageParams?: Record<string, string | number | boolean>
  field?: string
}

export type SuggestedDirectory = {
  path: string
  purpose: string
  source: string
  validationStatus: 'valid' | 'invalid' | 'unavailable'
}

export type PreflightReport = {
  status: 'passed' | 'blocked' | 'unavailable'
  blockers: PreflightIssue[]
  suggestedDirectories: SuggestedDirectory[]
}

export type ButlerTaskWriteResult =
  | { ok: true; id: string; task?: AutomationTask }
  | { ok: false; kind: 'preflight-blocked'; report: PreflightReport; error?: string }
  | { ok: false; kind: 'validation-error' | 'preflight-unavailable'; error: string; field?: string }

export type ButlerRunTaskResult = {
  ok: boolean
  runId?: string
  sessionId?: string
  summary?: string
  deliveryStatus?: AutomationTaskRun['deliveryStatus']
  error?: string
}

/** Compatibility adapter: explicit canonical roots win; legacy single root is the only fallback. */
export function getAutomationTaskWorkDirs(task: Pick<AutomationTask, 'workDir' | 'workDirs'>): string[] {
  const roots = task.workDirs
  if (Array.isArray(roots)) return [...roots]
  if (typeof task.workDir === 'string' && task.workDir.trim().length > 0) return [task.workDir]
  return []
}
