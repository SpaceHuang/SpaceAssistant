export type AgentLogLevel = 'info' | 'warn' | 'error'

export type AgentLogEventName =
  | 'agent.startup'
  | 'llm.request'
  | 'llm.max_tokens_floor'
  | 'llm.response'
  | 'llm.error'
  | 'tool.request'
  | 'tool.confirm'
  | 'tool.error'
  | 'tool.result'
  | 'tool.progress'
  | 'skills.load'
  | 'skills.match'
  | 'skills.invoke'

export type AgentLogFields = Record<string, unknown>
