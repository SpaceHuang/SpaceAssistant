export function shouldStopToolRetry(
  toolName: string,
  error: string,
  data: unknown,
  repeatedFailure: boolean
): boolean {
  if (toolName !== 'run_shell' || error !== 'SHELL_DIALECT_MISMATCH') return repeatedFailure
  return typeof data === 'object' && data !== null && (data as { retryExhausted?: unknown }).retryExhausted === true
}
