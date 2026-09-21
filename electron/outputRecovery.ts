export const MAX_OUTPUT_RECOVERIES = 2

export type OutputRecoveryKind = 'output_truncated_without_tools' | 'output_truncated_with_tools' | 'none'

type ContentBlock = { type?: unknown; text?: unknown; thinking?: unknown }

export function classifyOutputRecovery(args: {
  stopReason?: string
  content: readonly ContentBlock[]
}): OutputRecoveryKind {
  if (args.stopReason !== 'max_tokens') return 'none'
  if (args.content.some((block) => block?.type === 'tool_use')) return 'output_truncated_with_tools'
  return 'output_truncated_without_tools'
}

export function buildTruncatedToolResults(toolUses: readonly { id?: string }[]): Array<{
  type: 'tool_result'
  tool_use_id: string
  is_error: true
  content: string
}> {
  return toolUses
    .filter((tool) => typeof tool.id === 'string' && tool.id.length > 0)
    .map((tool) => ({
      type: 'tool_result' as const,
      tool_use_id: tool.id!,
      is_error: true as const,
      content: '本轮工具生成因达到输出 token 上限而被截断，工具未执行。请重新生成一个完整且更小的工具调用。'
    }))
}

export function shouldRecoverOutput(recoveryCount: number): boolean {
  return recoveryCount < MAX_OUTPUT_RECOVERIES
}

export type OutputRecoveryMessage = {
  role: 'user'
  source: 'runtime'
  content: string
  metadata: {
    kind: 'model_output_token_limit'
    attempt: number
    causeRequestId: string
    answerMode: 'continue'
  }
}

export function buildOutputRecoveryMessage(args: {
  attempt: number
  causeRequestId: string
  hadVisibleText: boolean
  hadToolUse?: boolean
}): OutputRecoveryMessage {
  const visibility = args.hadVisibleText
    ? '上一轮已生成部分用户可见正文，请从未完成处继续，避免重复。'
    : args.hadToolUse
      ? '上一轮已生成工具调用，但因输出被截断而未执行；请基于紧邻的失败工具结果重新生成完整调用。'
      : '上一轮没有生成用户可见正文。'
  return {
    role: 'user',
    source: 'runtime',
    content: `[运行时恢复通知：model_output_token_limit]\n上一轮模型输出因达到单次输出 token 上限而被截断，该轮未完成当前任务。这不是新的用户请求。${visibility}请继续处理原任务，保留已经完成的工具操作及其结果；需要工具时调用工具，已有足够信息时给出完整回答。不要重新执行上下文中已有结果的工具操作。`,
    metadata: {
      kind: 'model_output_token_limit',
      attempt: args.attempt,
      causeRequestId: args.causeRequestId,
      answerMode: 'continue'
    }
  }
}
