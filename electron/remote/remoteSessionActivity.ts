import type { SessionCommands } from '../sessionStorage/contracts'

export function touchRemoteSessionActivity(
  commands: Pick<SessionCommands, 'recordRemoteSessionActivity'>,
  sessionId: string,
  at: number = Date.now()
): void {
  commands.recordRemoteSessionActivity(sessionId, at)
}
