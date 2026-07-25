import { logAgentEvent } from './agentLogger/agentLogger'
import type { AgentLogFields } from './agentLogger/types'
import { sanitizeForLog } from './logSanitize'

/** 闸 1（历史重建）超长 tool_result 压缩时的统一 warn 日志 */
export function logHistoryOversizedToolResult(args: {
  sessionId?: string
  toolUseId: string
  originalLength: number
  compactedLength: number
  source: string
}): void {
  logAgentEvent(
    'warn',
    'tool.result.oversized.compacted',
    sanitizeForLog({
      sessionId: args.sessionId,
      toolUseId: args.toolUseId,
      originalLength: args.originalLength,
      compactedLength: args.compactedLength,
      source: args.source
    }) as AgentLogFields
  )
}
