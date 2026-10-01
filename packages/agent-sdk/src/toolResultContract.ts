/**
 * R4：工具结果信封的单一契约——失败码闭合枚举 + 不变量断言 + 事实优先归一。
 *
 * 归一纪律（评审 P2-4）：`exitCode` / `terminationReason` / `aborted` 一律取自
 * 同一信封的 `data`（`data.exitCode` / `data.terminationReason` / `data.status === 'cancelled'`），
 * 不从进程回调、外部状态或调用方传参取——否则「归一依据」与「事实」会分叉出第二份副本。
 */

/** 五类细分失败码（闭合枚举，拒绝插件扩展） */
export type ToolErrorCode =
  | 'TOOL_EXEC_FAILED' // 执行了但失败：非零退出码 / 进程被杀（有事实依据）
  | 'TOOL_EXECUTOR_ERROR' // 执行器自身异常（spawn 失败、内部抛出、文件系统意外）
  | 'POLICY_NOT_EXECUTED' // 被安全 / 授权 / 预算拦下（未执行）
  | 'TOOL_USER_CANCELLED' // 用户取消 / 超时前的主动中断
  | 'TOOL_INVALID_INPUT' // 参数非法（校验层拒绝，未执行）

export const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  'TOOL_EXEC_FAILED',
  'TOOL_EXECUTOR_ERROR',
  'POLICY_NOT_EXECUTED',
  'TOOL_USER_CANCELLED',
  'TOOL_INVALID_INPUT'
] as const

export function isToolErrorCode(code: unknown): code is ToolErrorCode {
  return typeof code === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * 旧 `SHELL_*` 失败码 → 新码映射（长期保留，不设删除期限——O6 定案）。
 * 只作用于历史消息回显与归一，删除收益≈0、删错（老会话显示异常）代价真实。
 */
export const LEGACY_TOOL_ERROR_CODE_MAP: Readonly<Record<string, ToolErrorCode>> = {
  SHELL_PROCESS_EXIT: 'TOOL_EXEC_FAILED',
  SHELL_SPAWN_ERROR: 'TOOL_EXECUTOR_ERROR',
  SHELL_TIMEOUT: 'TOOL_EXEC_FAILED', // terminationReason='timeout' 区分
  SHELL_CANCELLED: 'TOOL_USER_CANCELLED',
  SHELL_ARTIFACT_PATH_INVALID: 'TOOL_EXECUTOR_ERROR'
} as const

export interface ToolResultEnvelope {
  success: boolean
  error?: string
  userMessageKey?: string
  userMessageParams?: Record<string, string | number>
  notExecuted?: true
  notExecutedReason?: string
  data?: unknown
}

export type ToolResultInvariantId = 'I0' | 'I1' | 'I2' | 'I3' | 'I4' | 'I5'

export interface ToolViolation {
  invariant: ToolResultInvariantId
  detail: string
}

/**
 * 不变量（可执行断言，对齐需求 §R4 验收）：
 * - I0：`success` 必须是布尔
 * - I1：`success === true ⇒ error == null && notExecuted !== true`
 * - I2：`data.exitCode === 0 && data.terminationReason === 'process_exit' && !aborted ⇒ success === true`（不得标记失败）
 * - I3：`notExecuted === true ⇒ success === false && notExecutedReason != null`
 * - I4：`aborted || timedOut || exitCode !== 0 ⇒ success === false`
 * - I5：`error` 若存在必须属于闭合枚举（或映射表内的旧码）
 */
export function normalizeToolResultEnvelope(
  raw: unknown,
  opts?: { knownErrorCodes?: ReadonlySet<string> }
): { envelope: ToolResultEnvelope; violations: ToolViolation[] } {
  const violations: ToolViolation[] = []
  if (!raw || typeof raw !== 'object' || typeof (raw as { success?: unknown }).success !== 'boolean') {
    return {
      envelope: { success: false, error: 'TOOL_EXECUTOR_ERROR', data: { status: 'result_invalid' } },
      violations: [{ invariant: 'I0', detail: 'missing success boolean' }]
    }
  }
  let env = raw as ToolResultEnvelope

  // 事实取源（P2-4）：只读同一信封的 data
  const data = (env.data ?? undefined) as { exitCode?: unknown; terminationReason?: unknown; status?: unknown } | undefined
  const exitCode = data && typeof data === 'object' && typeof data.exitCode === 'number' ? data.exitCode : undefined
  const terminationReason =
    data && typeof data === 'object' && typeof data.terminationReason === 'string' ? data.terminationReason : undefined
  const aborted = Boolean(data && typeof data === 'object' && data.status === 'cancelled')
  const timedOut = terminationReason === 'timeout'
  const hasProcessFacts = exitCode !== undefined || terminationReason !== undefined

  const exitOk = exitCode === 0 && terminationReason === 'process_exit' && !aborted

  // I2：有事实依据的成功不得被判失败（今天的病根：矛盾时把成功改判失败）
  if (exitOk && env.success !== true) {
    env = {
      ...env,
      success: true,
      error: undefined,
      notExecuted: undefined,
      notExecutedReason: undefined
    }
    violations.push({ invariant: 'I2', detail: 'exitCode=0 + process_exit 被判失败，已按事实归一为成功' })
  }

  // I4：非零退出 / 中止 / 超时不得被判成功
  const executionFailed = (exitCode !== undefined && exitCode !== 0) || aborted || timedOut
  if (executionFailed && env.success === true) {
    env = { ...env, success: false, error: env.error ?? 'TOOL_EXEC_FAILED' }
    violations.push({
      invariant: 'I4',
      detail: aborted
        ? '用户取消被判成功，已按事实归一为失败'
        : timedOut
          ? '超时被判成功，已按事实归一为失败'
          : 'exitCode!=0 被判成功，已按事实归一为失败'
    })
  }

  // I3：未执行必须显式且带原因（notExecuted 是显式强语义，先于 I1 处理）
  if (env.notExecuted === true) {
    if (env.notExecutedReason == null) {
      env = { ...env, notExecutedReason: 'unknown' }
      violations.push({ invariant: 'I3', detail: 'notExecuted 缺少 notExecutedReason，已补 unknown' })
    }
    if (env.success !== false) {
      env = { ...env, success: false }
      violations.push({ invariant: 'I3', detail: 'notExecuted=true 但 success!=false，已归一' })
    }
  }

  // I1：成功分支不得携带 error（notExecuted 场景已由 I3 处理为失败）
  if (env.success === true && env.error !== undefined) {
    env = { ...env, error: undefined }
    violations.push({ invariant: 'I1', detail: 'success 与 error 并存，已清除' })
  }

  // I5：错误码闭合性（旧码映射 → 新码；未知码保留但告警）
  if (env.error !== undefined && !env.success) {
    const known =
      isToolErrorCode(env.error) ||
      env.error in LEGACY_TOOL_ERROR_CODE_MAP ||
      opts?.knownErrorCodes?.has(env.error) ||
      env.error === 'OUTPUT_LIMIT_REACHED'
    if (!known) {
      violations.push({ invariant: 'I5', detail: `未知错误码 ${String(env.error)}（不在闭合枚举内）` })
    }
  }

  // 无进程事实的信封不做以上事实归一（已由 hasProcessFacts 间接保证：exitOk/executionFailed 均要求事实存在）
  void hasProcessFacts
  return { envelope: env, violations }
}
