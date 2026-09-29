import type { CanonicalModelMessage, PreparedModelCall } from '../../packages/agent-sdk/src/model'
import type { ClaudeContentBlockMessage } from '../toolChatLoop'
import { toCanonicalModelMessages } from './canonicalHistory'

type HostedModelTool = Readonly<{
  name: string
  description: string
  input_schema: Record<string, unknown>
  strict?: boolean
}>

/** Builds the SDK request from host inputs without constructing an Anthropic wire request first. */
export function createHostedModelRequest(input: Readonly<{
  system?: string
  messages: readonly ClaudeContentBlockMessage[]
  tools: readonly HostedModelTool[]
  maxTokens: number
  thinking: Readonly<{ type: 'adaptive' | 'disabled' }>
  effort?: 'low' | 'medium' | 'high' | 'max'
  apiKey?: string
  signal?: AbortSignal
}>): PreparedModelCall['request'] {
  return {
    messages: [
      ...(typeof input.system === 'string' && input.system.trim() ? [{ role: 'system' as const, content: input.system }] : []),
      ...toCanonicalModelMessages(input.messages as never)
    ],
    maxTokens: input.maxTokens,
    ...(input.apiKey ? { credentials: { apiKey: input.apiKey } } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
      ...(tool.strict === true ? { strictSchema: 'require' as const } : {})
    })),
    thinking: {
      enabled: input.thinking.type === 'adaptive',
      ...(input.effort ? { effort: input.effort } : {})
    }
  }
}

/** Bind the persisted current-user identity to its unique canonical request message. */
export function bindHostedRequiredUserMessage(input: Readonly<{
  id: string
  originalMessages: readonly ClaudeContentBlockMessage[]
  requestMessages: readonly CanonicalModelMessage[]
}>): Readonly<{ id: string; message: CanonicalModelMessage }> | undefined {
  const original = input.originalMessages.find((message) => message.role === 'user' && message.id === input.id)
  if (!original) return undefined
  const [required] = toCanonicalModelMessages([original as never])
  if (!required || required.role !== 'user') return undefined
  const contentKey = (message: CanonicalModelMessage) => JSON.stringify(message.role === 'user' ? message.content : undefined)
  const expected = contentKey(required)
  const matches = input.requestMessages.filter((message) => message.role === 'user' && contentKey(message) === expected)
  if (matches.length !== 1) return undefined
  return { id: input.id, message: matches[0]! }
}
