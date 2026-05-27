import type { PlanExecutionMode, PlanExecutionRunState } from '../../../shared/planTypes'

export type PlanExecutionUiState = {
  /** 会话级：LLM/工具任务进行中 */
  sessionRunning: boolean
  /** Plan 专用：resume/cancel/approve 触发的 IPC 或 Worker 生命周期 */
  planActionLoading: boolean
  /** 合成：按钮应显示 loading */
  resumeButtonBusy: boolean
  /** 合成：按钮应 disabled */
  resumeButtonDisabled: boolean
  activePlanId: string | null
  planDrafting: boolean
  runState: PlanExecutionRunState
  executionMode: PlanExecutionMode
  /** auto 模式且 runState === running */
  isAutoRunning: boolean
  /** 主按钮应显示暂停（auto + running） */
  showPauseButton: boolean
}

export function derivePlanExecutionUiState(args: {
  sessionRunning: boolean
  planActionLoading: boolean
  activePlanId: string | null
  planDrafting: boolean
  runState?: PlanExecutionRunState
  executionMode?: PlanExecutionMode
}): PlanExecutionUiState {
  const { sessionRunning, planActionLoading, planDrafting } = args
  const runState = args.runState ?? 'idle'
  const executionMode = args.executionMode ?? 'auto'
  const isAutoRunning = executionMode === 'auto' && runState === 'running'
  const resumeButtonBusy = planActionLoading || (sessionRunning && !isAutoRunning)
  const resumeButtonDisabled = resumeButtonBusy || planDrafting
  return {
    sessionRunning,
    planActionLoading,
    resumeButtonBusy,
    resumeButtonDisabled,
    activePlanId: args.activePlanId,
    planDrafting,
    runState,
    executionMode,
    isAutoRunning,
    showPauseButton: isAutoRunning
  }
}
