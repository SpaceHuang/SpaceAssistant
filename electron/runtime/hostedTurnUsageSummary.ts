import type { CanonicalTurnMessage } from '../../packages/agent-sdk/src/turn'

export type HostedTurnUsageCounts = {
  stepCount: number
  toolCallCount: number
  toolErrorCount: number
  toolSkippedCount: number
}

export function mergeHostedTurnUsageSummary(
  counts: HostedTurnUsageCounts,
  input: Readonly<{ modelTurns: number; initialMessageCount: number; messages: readonly CanonicalTurnMessage[]; notDispatchedToolCallIds?: readonly string[] }>
): void {
  if (!Number.isInteger(input.modelTurns) || input.modelTurns < 0
    || !Number.isInteger(input.initialMessageCount) || input.initialMessageCount < 0
    || input.initialMessageCount > input.messages.length
    || Object.values(counts).some((count) => !Number.isInteger(count) || count < 0)) {
    throw new Error('HOSTED_USAGE_CHECKPOINT_INVALID')
  }
  const toolResults = input.messages.slice(input.initialMessageCount).filter((message) => message.role === 'tool')
  const notDispatched = new Set(input.notDispatchedToolCallIds ?? [])
  if ([...notDispatched].some((id) => typeof id !== 'string' || id.trim() === '')) throw new Error('HOSTED_USAGE_CHECKPOINT_INVALID')
  const replayedToolIds = new Set(toolResults.map((message) => message.toolCallId))
  const notDispatchedOnly = [...notDispatched].filter((id) => !replayedToolIds.has(id))
  counts.stepCount += input.modelTurns
  counts.toolCallCount += toolResults.length + notDispatchedOnly.length
  counts.toolErrorCount += toolResults.filter((message) => message.isError === true && !notDispatched.has(message.toolCallId)).length
  counts.toolSkippedCount += notDispatched.size
}
