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
  deliveryStatus: 'pending' | 'delivered' | 'failed-degraded' | 'delivery-uncertain' | 'none'
  deliveredAt?: number
  createdAt: number
  updatedAt: number
}

export type AutomationTaskRunConfigSnapshot = {
  resolutionStatus: 'resolved' | 'failed'
  workDir?: string
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

export type ButlerTaskWriteResult = { ok: boolean; id?: string; error?: string }

export type ButlerRunTaskResult = {
  ok: boolean
  runId?: string
  sessionId?: string
  summary?: string
  deliveryStatus?: AutomationTaskRun['deliveryStatus']
  error?: string
}
