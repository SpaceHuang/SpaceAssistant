import { createHash } from 'node:crypto'

export function buildCommandRetryKey(input: {
  toolName: string
  errorCode: string
  status?: string
  exitCode?: number | null
  signal?: string
  shellProfile?: string
  command?: string
  cwd?: string
  planDigest?: string
}): string {
  const semantic = JSON.stringify({
    toolName: input.toolName,
    errorCode: input.errorCode,
    status: input.status ?? '',
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? '',
    shellProfile: input.shellProfile ?? '',
    command: input.command ?? '',
    cwd: input.cwd ?? '',
    planDigest: input.planDigest ?? ''
  })
  return `${input.toolName}:${input.errorCode}:${createHash('sha256').update(semantic).digest('hex')}`
}

export function isInfrastructureError(errorCode: string): boolean {
  // 基础设施类失败（进程/依赖起不来、结果无法序列化）不值得按工具语义重试，
  // 一次即熔断；此前只覆盖 SHELL_*，SCRIPT_*/LARK_* 仍走"连续 3 次"的通用路径。
  return /^(SHELL_SPAWN_ERROR|SHELL_RESULT_|SHELL_OUTPUT_CAPTURE_LOST|SHELL_EXECUTOR_|SCRIPT_SPAWN_ERROR|LARK_RUNNER_UNAVAILABLE)/.test(errorCode)
}

export function shouldStopToolRetry(
  toolName: string,
  error: string,
  data: unknown,
  repeatedFailure: boolean
): boolean {
  if (isInfrastructureError(error)) return true
  if (toolName !== 'run_shell' || error !== 'SHELL_DIALECT_MISMATCH') return repeatedFailure
  return typeof data === 'object' && data !== null && (data as { retryExhausted?: unknown }).retryExhausted === true
}
