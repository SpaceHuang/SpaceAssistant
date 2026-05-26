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
}

export function derivePlanExecutionUiState(args: {
  sessionRunning: boolean
  planActionLoading: boolean
  activePlanId: string | null
  planDrafting: boolean
}): PlanExecutionUiState {
  const { sessionRunning, planActionLoading, planDrafting } = args
  const resumeButtonBusy = planActionLoading || sessionRunning
  const resumeButtonDisabled = resumeButtonBusy || planDrafting
  return {
    sessionRunning,
    planActionLoading,
    resumeButtonBusy,
    resumeButtonDisabled,
    activePlanId: args.activePlanId,
    planDrafting
  }
}
