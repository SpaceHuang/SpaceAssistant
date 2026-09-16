/**
 * 管家任务共享类型（P6 IPC 面）：主进程 taskStore 与渲染端设置页共用。
 */

export type AutomationTaskSchedule =
  | { kind: 'interval'; intervalMinutes: number }
  | { kind: 'daily'; time: string }

export type AutomationDeliveryPref = 'desktop' | 'feishu' | 'wechat' | 'none'

export type AutomationTask = {
  id: string
  name: string
  schedule: AutomationTaskSchedule
  prompt: string
  deliveryPref: AutomationDeliveryPref
  deliveryTarget?: string
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
  deliveryStatus: 'pending' | 'delivered' | 'failed-degraded' | 'none'
  deliveredAt?: number
  createdAt: number
  updatedAt: number
}

export type ButlerTaskWriteResult = { ok: boolean; id?: string; error?: string }

export type ButlerRunTaskResult = {
  ok: boolean
  runId?: string
  sessionId?: string
  summary?: string
  error?: string
}
