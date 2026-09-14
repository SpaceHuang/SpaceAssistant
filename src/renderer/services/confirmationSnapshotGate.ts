import type { TurnDisplay } from '../../shared/turnDisplayProtocol'

export type ConfirmationSnapshot = {
  sessionId: string
  turnId: string
  requestId: string
  turnVersion: number
  toolCallId: string
  confirmation: { complete: true }
}

export function canApproveConfirmation(
  display: Pick<TurnDisplay, 'turnId' | 'requestId' | 'version' | 'lifecycle'> & { sessionId: string; confirmingToolCallId?: string },
  snapshot: ConfirmationSnapshot | undefined
): boolean {
  return Boolean(
    snapshot?.confirmation.complete === true &&
    display.lifecycle === 'awaiting-confirmation' &&
    display.confirmingToolCallId &&
    snapshot.sessionId === display.sessionId &&
    snapshot.turnId === display.turnId &&
    snapshot.requestId === display.requestId &&
    snapshot.turnVersion === display.version &&
    snapshot.toolCallId === display.confirmingToolCallId
  )
}
