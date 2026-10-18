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
export type AutomationOutputOrganization = 'direct' | 'daily' | 'hourly'

export function getDefaultAutomationOutputOrganization(schedule: AutomationTaskSchedule): AutomationOutputOrganization {
  switch (schedule.kind) {
    case 'daily': return 'daily'
    case 'interval': return 'hourly'
    case 'once': return 'direct'
  }
}

export type AutomationTask = {
  id: string
  name: string
  schedule: AutomationTaskSchedule
  prompt: string
  deliveryPref: AutomationDeliveryPref
  deliveryTarget?: string
  /** Canonical user-approved roots for reading/modifying existing materials. */
  authorizedDirs: string[]
  /** Compatibility projection retained until all run consumers move to authorizedDirs. */
  workDirs: string[]
  /** IPC/数据库旧版本兼容字段；新调用统一使用 workDirs。 */
  workDir?: string
  /** Null only for historical tasks that have not been edited under the split-directory contract. */
  outputDir: string | null
  outputOrganization: AutomationOutputOrganization | null
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
  /** New IPC payloads use authorizedDirs; workDirs remains during the caller migration. */
  authorizedDirs?: string[]
  workDirs: string[]
  outputDir?: string
  outputOrganization?: AutomationOutputOrganization
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
  taskName?: string
  prompt?: string
  schedule?: AutomationTaskSchedule
  deliveryPref?: AutomationDeliveryPref
  deliveryTarget?: string
  taskRevision?: number
  workDirs?: string[]
  preflightVersion?: 0 | 1
  targetSelections?: TargetSelection[]
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

export type TargetBinding =
  | { kind: 'exact'; path: string; targetType: 'file' | 'directory'; targetReference: { kind: 'basename' | 'path'; value: string }; rawText: string; resolverVersion: number; rootsDigest: string; taskRevision: number }
  | { kind: 'collection'; directory: string; selector: '*.csv' | '*.tsv' | 'all'; sort: 'canonical-path'; rawText: string; resolverVersion: number; rootsDigest: string; taskRevision: number }
  | { kind: 'output'; path: string; ancestor: string; relativeSuffix: string; outputRoot?: string; expectedType: 'file' | 'directory'; rawText: string; resolverVersion: number; rootsDigest: string; taskRevision: number }

export type TargetSelection = TargetBinding

export const PREFLIGHT_ISSUE_MESSAGE_KEYS = {
  ONCE_AT_NOT_FUTURE: 'butler.preflight.once_at_not_future',
  ROOT_FACTS_UNAVAILABLE: 'butler.preflight.root_facts_unavailable',
  FACTS_INCOMPLETE: 'butler.preflight.facts_incomplete',
  ANALYZER_UNAVAILABLE: 'butler.preflight.analyzer_unavailable',
  ANALYZER_INVALID_RESPONSE: 'butler.preflight.analyzer_invalid_response',
  TARGET_UNCLEAR: 'butler.preflight.target_unclear',
  TARGET_AMBIGUOUS: 'butler.preflight.target_ambiguous',
  TARGET_NOT_FOUND: 'butler.preflight.target_not_found',
  TARGET_OUTSIDE_ROOTS: 'butler.preflight.target_outside_roots',
  TARGET_UNVERIFIABLE: 'butler.preflight.target_unverifiable',
  TARGET_TYPE_MISMATCH: 'butler.preflight.target_type_mismatch',
  NO_ROOTS: 'butler.preflight.no_roots',
  OUTPUT_PATH_ESCAPE: 'butler.preflight.output_path_escape',
  OUTPUT_ANCESTOR_INVALID: 'butler.preflight.output_ancestor_invalid',
  SELECTOR_UNSUPPORTED: 'butler.preflight.selector_unsupported'
} as const

export const PREFLIGHT_CLARIFICATION_REASON_MESSAGE_KEYS = {
  no_target_identified: 'butler.preflight.reasons.no_target_identified',
  scope_unclear: 'butler.preflight.reasons.scope_unclear',
  missing_location: 'butler.preflight.reasons.missing_location',
  multiple_matches: 'butler.preflight.reasons.multiple_matches',
  target_missing: 'butler.preflight.reasons.target_missing',
  other: 'butler.preflight.reasons.other'
} as const

export type PreflightClarificationReasonCode = keyof typeof PREFLIGHT_CLARIFICATION_REASON_MESSAGE_KEYS

export function getPreflightIssueMessageKey(code: string): string {
  return PREFLIGHT_ISSUE_MESSAGE_KEYS[code as keyof typeof PREFLIGHT_ISSUE_MESSAGE_KEYS] ?? 'butler.preflight.unknown'
}

export function getPreflightClarificationReasonMessageKey(reasonCode: string): string {
  return PREFLIGHT_CLARIFICATION_REASON_MESSAGE_KEYS[reasonCode as PreflightClarificationReasonCode] ?? PREFLIGHT_CLARIFICATION_REASON_MESSAGE_KEYS.other
}

export type PreflightIssue = {
  code: string
  messageKey: string
  messageParams?: Record<string, string | number | boolean>
  field?: string
  reference?: string
  reasonCode?: PreflightClarificationReasonCode
  candidates?: string[]
  candidateCount?: number
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
  | { ok: true; id: string; task?: AutomationTask; preflightReport?: PreflightReport }
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

/** Shared canonical roots accessor; legacy conversion is restricted to the IPC/DB boundary. */
export function getAutomationTaskWorkDirs(task: Pick<AutomationTask, 'workDirs'> & { workDir?: string }): string[] {
  if (Array.isArray(task.workDirs)) return [...task.workDirs]
  return typeof task.workDir === 'string' && task.workDir.length > 0 ? [task.workDir] : []
}
