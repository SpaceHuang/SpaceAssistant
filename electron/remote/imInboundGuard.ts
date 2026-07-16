import { remoteAuthorizationRegistry, type RemoteAuthChannel } from './remoteAuthorizationRegistry'

export type ImInboundGuardConfig = {
  enabled?: boolean
  remoteEnabled?: boolean
  loggedIn?: boolean
  remoteSenderAllowlist?: string[]
}

export type ImAuthSnapshot = {
  channel: RemoteAuthChannel
  owner: string
  authorizationGeneration: number
  capturedAt: number
}

export type GuardResult =
  | { ok: true; snapshot: ImAuthSnapshot }
  | {
      ok: false
      reason: 'channel_disabled' | 'remote_disabled' | 'not_logged_in' | 'not_owner' | 'revoked'
    }

/**
 * Shared IM inbound authorization gate.
 * Success returns a one-shot auth snapshot carrying authorizationGeneration.
 * Call revalidate(snapshot) after every await that may change external auth state.
 */
export function evaluateImInboundGuard(args: {
  channel: RemoteAuthChannel
  senderId: string
  getConfig: () => ImInboundGuardConfig
  /** Optional login probe (WeChat). Default: treat as logged in when omitted. */
  isLoggedIn?: () => boolean
}): GuardResult {
  const cfg = args.getConfig()
  if (cfg.enabled === false) return { ok: false, reason: 'channel_disabled' }
  if (!cfg.remoteEnabled) return { ok: false, reason: 'remote_disabled' }
  const loggedIn = args.isLoggedIn ? args.isLoggedIn() : cfg.loggedIn !== false
  if (!loggedIn) return { ok: false, reason: 'not_logged_in' }
  const allow = cfg.remoteSenderAllowlist ?? []
  if (!allow.length || !allow.includes(args.senderId)) {
    return { ok: false, reason: 'not_owner' }
  }
  return {
    ok: true,
    snapshot: {
      channel: args.channel,
      owner: args.senderId,
      authorizationGeneration: remoteAuthorizationRegistry.getGeneration(args.channel),
      capturedAt: Date.now()
    }
  }
}

export function revalidateImInboundGuard(
  snapshot: ImAuthSnapshot,
  args: {
    getConfig: () => ImInboundGuardConfig
    isLoggedIn?: () => boolean
  }
): GuardResult {
  const again = evaluateImInboundGuard({
    channel: snapshot.channel,
    senderId: snapshot.owner,
    getConfig: args.getConfig,
    isLoggedIn: args.isLoggedIn
  })
  if (!again.ok) return again
  if (again.snapshot.authorizationGeneration !== snapshot.authorizationGeneration) {
    return { ok: false, reason: 'revoked' }
  }
  return again
}
