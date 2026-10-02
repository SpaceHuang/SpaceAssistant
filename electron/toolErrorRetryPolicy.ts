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
  return /^(SHELL_SPAWN_ERROR|SHELL_RESULT_|SHELL_OUTPUT_CAPTURE_LOST|SHELL_EXECUTOR_|SCRIPT_SPAWN_ERROR|LARK_RUNNER_UNAVAILABLE|TOOL_EXECUTOR_ERROR)/.test(errorCode)
}

/** Tracks a failed semantic operation across model responses, never across sibling calls. */
export class SemanticToolRetryTracker {
  private readonly failuresByIdentity = new Map<string, number>()
  private readonly observedCallsByResponse = new Map<number, Set<string>>()

  constructor(private readonly threshold: number) {}

  observe(input: Readonly<{ response: number; toolCallId: string; identity: string; errorClass: string }>): boolean {
    const key = `${input.identity}\0${input.errorClass}`
    return (this.failuresByIdentity.get(key) ?? 0) >= this.threshold
  }

  recordFailure(input: Readonly<{ response: number; toolCallId: string; identity: string; errorClass: string }>): void {
    const key = `${input.identity}\0${input.errorClass}`
    const calls = this.observedCallsByResponse.get(input.response) ?? new Set<string>()
    this.observedCallsByResponse.set(input.response, calls)
    if (calls.has(key)) return
    calls.add(key)
    this.failuresByIdentity.set(key, (this.failuresByIdentity.get(key) ?? 0) + 1)
  }

  clearIdentity(identity: string): void {
    for (const key of this.failuresByIdentity.keys()) if (key.startsWith(`${identity}\0`)) this.failuresByIdentity.delete(key)
  }

  errorClasses(identity: string): string[] {
    return [...this.failuresByIdentity.keys()].filter((key) => key.startsWith(`${identity}\0`)).map((key) => key.slice(identity.length + 1))
  }

  clear(identity: string): void {
    for (const key of this.failuresByIdentity.keys()) if (key.startsWith(`${identity}\0`)) this.failuresByIdentity.delete(key)
  }
}

export function normalizeFileToolIdentity(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const rawPath = typeof input.path === 'string' ? input.path
    : typeof input.filePath === 'string' ? input.filePath
      : typeof input.file_path === 'string' ? input.file_path : ''
  const normalizedPath = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(^|\/)\.\//g, '$1').replace(/\/$/, '')
  const operation = toolName === 'edit_file' ? 'edit' : toolName === 'write_file' ? 'write' : 'read'
  const relevant = Object.fromEntries(Object.entries(input)
    .filter(([key]) => !['path', 'filePath', 'file_path'].includes(key) && !/token|secret|credential|password/i.test(key))
    .sort(([left], [right]) => left.localeCompare(right)))
  return `${toolName}:${operation}:${createHash('sha256').update(JSON.stringify({ path: normalizedPath, params: relevant })).digest('hex')}`
}

export function normalizeToolErrorClass(error: string, output?: Readonly<Record<string, unknown>>): string {
  const explicitCode = typeof output?.errorCode === 'string' ? output.errorCode : undefined
  if (explicitCode && /^[A-Z0-9_]{1,64}$/.test(explicitCode)) return explicitCode
  if (/尚未在本会话中通过 read_file 读取|must be read before/i.test(error)) return 'READ_REQUIRED'
  if (/not found|不存在|no such file/i.test(error)) return 'TARGET_NOT_FOUND'
  if (/invalid|参数|required/i.test(error)) return 'INVALID_ARGUMENT'
  return 'TOOL_EXECUTION_FAILED'
}

export function shouldStopToolRetry(toolName: string, error: string, data: unknown): boolean {
  if (isInfrastructureError(error)) return true
  if (toolName === 'run_shell' && error === 'SHELL_DIALECT_MISMATCH') {
    return typeof data === 'object' && data !== null && (data as { retryExhausted?: unknown }).retryExhausted === true
  }
  return false
}
