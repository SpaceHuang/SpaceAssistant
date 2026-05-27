/** Plan Worker 执行期工具确认失败（timeout/rejected）追踪 */
const failures = new Map<string, string>()

export function markPlanConfirmFailure(requestId: string, reason: string): void {
  failures.set(requestId, reason)
}

export function consumePlanConfirmFailure(requestId: string): string | undefined {
  const reason = failures.get(requestId)
  failures.delete(requestId)
  return reason
}

export function clearPlanConfirmFailure(requestId: string): void {
  failures.delete(requestId)
}

/** 测试用 */
export function clearAllPlanConfirmFailures(): void {
  failures.clear()
}
