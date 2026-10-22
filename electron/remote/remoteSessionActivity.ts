import type { SessionCommands } from '../sessionStorage/public/ports'

export function touchRemoteSessionActivity(
  commands: Pick<SessionCommands, 'recordRemoteSessionActivity'>,
  sessionId: string,
  at: number = Date.now()
): void {
  commands.recordRemoteSessionActivity(sessionId, at)
}
