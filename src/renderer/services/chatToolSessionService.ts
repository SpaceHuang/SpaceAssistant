import type { TurnExecutePayload } from '../../shared/api'

export function buildToolChatPayload(args: {
  requestId: string
  sessionId: string
  turnId: string
  turnStartToken: string
}): TurnExecutePayload {
  return {
    requestId: args.requestId,
    sessionId: args.sessionId,
    turnId: args.turnId,
    turnStartToken: args.turnStartToken
  }
}

export { extractAssistantTextFromApiContent } from '../../shared/assistantContentReconcile'
