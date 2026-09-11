export interface AgentToolResultInput {
  success: boolean
  data?: unknown
  diagnostic?: unknown
  error?: string
  userMessage?: string
}

import { projectAgentToolResultForSink, type ProcessProjectionOptions } from './processResultProjection'

/** 实时 tool loop 与历史重建共用的 Agent-safe tool_result 内容。 */
export function serializeAgentToolResult(
  result: AgentToolResultInput,
  options: ProcessProjectionOptions = {}
): string {
  try {
    const projected = projectAgentToolResult(result, options)
    // 兼容终端型成功输出，但先经过同一套文本边界保护。
    if (projected.success && typeof projected.data === 'string') return projected.data
    const payload = {
      ok: projected.success,
      ...(projected.error ? { error: projected.error } : {}),
      ...(projected.userMessage ? { userMessage: projected.userMessage } : {}),
      ...(projected.diagnostic ? { diagnostic: projected.diagnostic } : {}),
      data: projected.data
    }
    return JSON.stringify(payload)
  } catch {
    return JSON.stringify({
      ok: false,
      error: 'SHELL_RESULT_SERIALIZATION_FAILED',
      data: null
    })
  }
}

/** 实时、历史、renderer/IM 事实链路共用的外部结果投影。 */
export function projectAgentToolResult(
  result: AgentToolResultInput,
  options: ProcessProjectionOptions = {}
): AgentToolResultInput {
  try {
    return projectAgentToolResultForSink(result, options) as AgentToolResultInput
  } catch {
    return { success: false, error: 'SHELL_RESULT_SERIALIZATION_FAILED', data: null }
  }
}
