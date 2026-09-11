import type { AgentLogEventName, AgentLogLevel } from '../agentLogger/types'

export type CapturedAgentLog = {
  level: AgentLogLevel
  event: AgentLogEventName
  fields: Record<string, unknown>
}

/** 供跨出口测试使用的内存 Agent 日志捕获器。 */
export function createAgentLogCapture() {
  const events: CapturedAgentLog[] = []
  return {
    events,
    record(level: AgentLogLevel, event: AgentLogEventName, fields: Record<string, unknown>): void {
      events.push({ level, event, fields })
    },
    serialized(): string {
      return JSON.stringify(events)
    }
  }
}
