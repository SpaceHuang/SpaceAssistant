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

/** Extract the actual user message when a repaired user surface also carries preceding tool results. */
export function canonicalHostedRequiredUserMessage(message: ClaudeContentBlockMessage): CanonicalModelMessage | undefined {
  return toCanonicalModelMessages([message as never]).reverse().find((candidate) => candidate.role === 'user')
}

/** Bind the persisted current-user identity to its unique canonical request message. */
export function bindHostedRequiredUserMessage(input: Readonly<{
  id: string
  originalMessages: readonly ClaudeContentBlockMessage[]
  requestMessages: readonly CanonicalModelMessage[]
}>): Readonly<{ id: string; message: CanonicalModelMessage }> | undefined {
  const sourceIndex = input.originalMessages.findIndex((message) => message.role === 'user' && message.id === input.id)
  if (sourceIndex < 0) return undefined
  const original = input.originalMessages[sourceIndex]!
  const required = canonicalHostedRequiredUserMessage(original)
  if (!required || required.role !== 'user') return undefined
  const contentKey = (message: CanonicalModelMessage) => {
    if (message.role !== 'user') return undefined
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map((block) => block.type === 'text' ? { type: 'text', text: block.text } : block)
    return JSON.stringify(content)
  }
  const expected = contentKey(required)
  const beforeCount = input.originalMessages.slice(0, sourceIndex)
    .reduce((count, message) => count + toCanonicalModelMessages([message as never]).length, 0)
  const originalCanonical = toCanonicalModelMessages([original as never])
  const requiredOffset = originalCanonical.findIndex((message) => message.role === 'user' && contentKey(message) === expected)
  if (requiredOffset < 0) return undefined
  const requestTranscript = input.requestMessages.filter((message) => message.role !== 'system')
  const candidate = requestTranscript[beforeCount + requiredOffset]
  if (!candidate || candidate.role !== 'user' || contentKey(candidate) !== expected) return undefined
  return { id: input.id, message: candidate }
}
