import type { AppDatabase } from '../database'
import type { RemoteContext } from '../tools/types'
import { touchRemoteSessionActivity } from './remoteSessionActivity'

/** Outbound suffix / idle-touch session: follows remoteContext.outboundSessionId after switch_session. */
export function resolveRemoteOutboundSessionId(
  remoteContext: RemoteContext | undefined,
  fallbackSessionId: string
): string {
  const sid = remoteContext?.outboundSessionId?.trim()
  return sid || fallbackSessionId
}

/**
 * After desktop switch succeeds, align IM outbound + idle continuation with target session.
 * Only mutates `outboundSessionId` — `originSessionId` (assistant messages, streaming,
 * completion, DB, progress cleanup, backup) stays bound to the request's origin session.
 */
export function adoptRemoteSessionAfterSwitch(args: {
  remoteContext: RemoteContext
  appDatabase: AppDatabase
  targetSessionId: string
}): void {
  args.remoteContext.outboundSessionId = args.targetSessionId
  touchRemoteSessionActivity(args.appDatabase, args.targetSessionId)
}
