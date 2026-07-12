import type { AppDatabase } from '../database'
import type { RemoteContext } from '../tools/types'
import { touchRemoteSessionActivity } from './remoteSessionActivity'

/** Outbound suffix / idle-touch session: follows remoteContext after switch_session. */
export function resolveRemoteOutboundSessionId(
  remoteContext: RemoteContext | undefined,
  fallbackSessionId: string
): string {
  const sid = remoteContext?.sessionId?.trim()
  return sid || fallbackSessionId
}

/** After desktop switch succeeds, align IM outbound + idle continuation with target session. */
export function adoptRemoteSessionAfterSwitch(args: {
  remoteContext: RemoteContext
  appDatabase: AppDatabase
  targetSessionId: string
}): void {
  args.remoteContext.sessionId = args.targetSessionId
  touchRemoteSessionActivity(args.appDatabase, args.targetSessionId)
}
