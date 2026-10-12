type ConfirmationFailureState = 'not-attempted' | 'send-rejected' | 'send-pending' | 'binding-unavailable' | 'unknown'

type ConfirmationFailure = Readonly<{
  state: ConfirmationFailureState
  toolCallId: string
  toolName: string
}>

export type ConfirmationFailureProjection = Readonly<{ summary: string; toolCallIds: readonly string[] }>

export function appendConfirmationFailureProjection(summary: string, projection?: ConfirmationFailureProjection): string {
  return projection ? `${summary}\n${projection.summary}` : summary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isErrorCategory(value: unknown): boolean {
  return value === 'bot-unavailable' || value === 'inbound-context-missing' || value === 'credentials-unavailable'
    || value === 'api-rejected' || value === 'transport-failed' || value === 'message-binding-unavailable' || value === 'unknown'
}

/** Validate current protocol facts and explicitly normalize pre-discriminator History records. */
function readFailureState(value: unknown): ConfirmationFailureState | undefined {
  if (!isRecord(value) || value.kind !== 'confirmation-prompt-send-failed') return undefined
  const { state, sendCall, delivery } = value
  if (state === 'not-attempted' && sendCall === 'not-attempted' && delivery === 'not-attempted' && isErrorCategory(value.errorCategory)) return 'not-attempted'
  if (state === 'send-rejected' && sendCall === 'rejected' && delivery === 'unknown' && isErrorCategory(value.errorCategory)) return 'send-rejected'
  if (state === 'send-pending' && sendCall === 'pending' && delivery === 'unknown' && value.errorCategory === 'unknown') return 'send-pending'
  if (state === 'binding-unavailable' && sendCall === 'fulfilled' && delivery === 'unavailable' && value.errorCategory === 'message-binding-unavailable') return 'binding-unavailable'

  // Old History entries predate `state`; accept only their known legal pairs.
  if (state === undefined) {
    if (sendCall === 'not-attempted' && delivery === 'not-attempted') return 'not-attempted'
    if (sendCall === 'rejected' && delivery === 'unknown') return 'send-rejected'
    if (sendCall === 'pending' && delivery === 'unknown') return 'send-pending'
    if (sendCall === 'fulfilled' && delivery === 'unavailable') return 'binding-unavailable'
    // Earliest persisted records carried only `delivery`; retain uncertainty without inventing a cause.
    if (sendCall === undefined && delivery === 'unknown') return 'unknown'
  }
  return 'unknown'
}

function receiptText(state: ConfirmationFailureState): string {
  switch (state) {
    case 'not-attempted': return '确认提示未尝试发送；本次确认已失效，相关操作未执行。'
    case 'send-rejected': return '确认提示发送调用失败，无法确认是否送达；本次确认已失效，相关操作未执行。'
    case 'send-pending': return '确认提示发送调用尚未完成，无法确认是否送达；本次确认已失效，相关操作未执行。'
    case 'binding-unavailable': return '确认提示发送调用已成功，但无法绑定平台消息；本次确认已失效，相关操作未执行。'
    case 'unknown': return '确认提示发送状态无法判定，无法确认是否送达；本次确认已失效，相关操作未执行。'
  }
}

export function projectConfirmationSendFailures(events: readonly { kind: string; payload: unknown }[]): ConfirmationFailureProjection | undefined {
  const toolNames = new Map<string, string>()
  for (const event of events) {
    if (event.kind !== 'model-response-committed' || !isRecord(event.payload)) continue
    const message = event.payload.message
    if (!isRecord(message) || !Array.isArray(message.toolCalls)) continue
    for (const call of message.toolCalls) {
      if (isRecord(call) && typeof call.id === 'string' && typeof call.name === 'string') toolNames.set(call.id, call.name)
    }
  }

  const failures: ConfirmationFailure[] = []
  for (const event of events) {
    if (event.kind !== 'approval-resolved' || !isRecord(event.payload)) continue
    const toolCallId = event.payload.toolCallId
    const promptSendFailure = event.payload.promptSendFailure
    if (typeof toolCallId !== 'string' || !isRecord(promptSendFailure) || promptSendFailure.kind !== 'confirmation-prompt-send-failed') continue
    const state = readFailureState(promptSendFailure)
    if (!state) continue
    failures.push({ toolCallId, toolName: toolNames.get(toolCallId) ?? '受保护操作', state })
  }
  if (!failures.length) return undefined
  return {
    toolCallIds: failures.map((failure) => failure.toolCallId),
    summary: failures.map((failure) => `工具调用 ${failure.toolName}（${failure.toolCallId}）：${receiptText(failure.state)}`).join('\n')
  }
}
