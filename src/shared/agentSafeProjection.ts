import { projectTelemetryToolResult, type ProcessProjectionOptions } from './processResultProjection'

export interface AgentSafeProcessMetadata {
  status?: string
  errorCode?: string
  caseId?: string
  exitCode?: number | null
  signal?: string | null
  terminationReason?: string
  durationMs?: number
  stdoutBytes?: number
  stderrBytes?: number
  stdoutSha256?: string
  stderrSha256?: string
  truncated?: boolean
  artifactAvailable?: boolean
  redacted?: boolean
}

/** 将进程工具结果投影为日志允许的元数据；未知字段默认丢弃。 */
export function projectProcessResultForAgentLog(
  value: unknown,
  options: ProcessProjectionOptions = {}
): AgentSafeProcessMetadata {
  try {
    const projected = projectTelemetryToolResult({ success: true, data: value }, { ...options, processTool: true })
    if (projected.errorCode === 'SHELL_RESULT_SERIALIZATION_FAILED') {
      const status = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).status
        : undefined
      return typeof status === 'string' && /^[a-z_]{1,64}$/.test(status) ? { status } : {}
    }
    return (projected.data ?? {}) as AgentSafeProcessMetadata
  } catch {
    const status = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).status
      : undefined
    return typeof status === 'string' && /^[a-z_]{1,64}$/.test(status) ? { status } : {}
  }
}
