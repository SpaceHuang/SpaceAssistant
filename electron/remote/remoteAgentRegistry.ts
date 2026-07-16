import { signalChatCancel } from '../chatCancelRegistry'

export type ClaimResult = 'ok' | 'session_busy' | 'parallel_full'

/** Default lease ceiling; mirrors the WP1 session-scoped write-grant window (30 min). */
export const DEFAULT_REMOTE_AGENT_LEASE_TTL_MS = 30 * 60_000

interface RemoteAgentLease {
  originSessionId: string
  requestId: string
  startedAt: number
  expiresAt: number
  cancel: () => void
}

export interface RemoteAgentLeaseSnapshot {
  originSessionId: string
  requestId: string
  startedAt: number
  expiresAt: number
}

export interface ClaimRemoteSessionOptions {
  /** Invoked when this lease is force-reclaimed (expiry) or explicitly cancelled. Defaults to aborting the request's chat/tool signal. */
  cancel?: () => void
  ttlMs?: number
  now?: number
}

/**
 * Remote agent run lease, keyed by originSessionId — the immutable session that owns the
 * current request's assistant messages, streaming state and DB/backup writes (WP6).
 *
 * A lease is only claimable by a fresh (originSessionId, requestId) pair: re-claiming with the
 * same requestId while the lease is live is idempotent ("ok"); any other requestId is
 * "session_busy" until the lease is released, cancelled or expires. Only the requestId that
 * holds the lease may release or cancel it — finally/cancel/timeout paths must all pass the
 * same requestId they claimed with.
 */
const leases = new Map<string, RemoteAgentLease>()

function isLive(lease: RemoteAgentLease | undefined, now: number): lease is RemoteAgentLease {
  return Boolean(lease) && lease!.expiresAt > now
}

/**
 * Atomically claim a remote agent run: single-flight per originSessionId + global parallel cap.
 * countRunningRemoteAgents() === number of distinct live leases.
 */
export function tryClaimRemoteSession(
  originSessionId: string,
  requestId: string,
  maxParallel: number,
  opts: ClaimRemoteSessionOptions = {}
): ClaimResult {
  const now = opts.now ?? Date.now()
  const existing = leases.get(originSessionId)

  if (isLive(existing, now)) {
    if (existing.requestId === requestId) return 'ok'
    return 'session_busy'
  }
  if (existing) leases.delete(originSessionId)

  if (leases.size >= maxParallel) {
    return 'parallel_full'
  }

  leases.set(originSessionId, {
    originSessionId,
    requestId,
    startedAt: now,
    expiresAt: now + (opts.ttlMs ?? DEFAULT_REMOTE_AGENT_LEASE_TTL_MS),
    cancel: opts.cancel ?? (() => signalChatCancel(requestId))
  })
  return 'ok'
}

/** Release only succeeds when requestId matches the current lease owner. Idempotent otherwise. */
export function releaseRemoteSession(originSessionId: string, requestId: string): void {
  const existing = leases.get(originSessionId)
  if (!existing || existing.requestId !== requestId) return
  leases.delete(originSessionId)
}

/**
 * Explicitly cancel the lease's owning request (invokes its cancel handle) and release it.
 * Only succeeds for the matching (originSessionId, requestId) pair. Returns whether a live
 * lease was cancelled.
 */
export function cancelRemoteSession(originSessionId: string, requestId: string): boolean {
  const existing = leases.get(originSessionId)
  if (!existing || existing.requestId !== requestId) return false
  leases.delete(originSessionId)
  try {
    existing.cancel()
  } catch {
    /* ignore cancel handle errors */
  }
  return true
}

/**
 * Is `originSessionId` currently held by a live lease?
 * Pass `exemptRequestId` to ask "is it busy for someone *other than* this requestId" — used by
 * switch_work_dir so the Agent holding the lease can still adjust its own session's workDir.
 */
export function isRemoteAgentRunning(
  originSessionId: string,
  opts: { exemptRequestId?: string; now?: number } = {}
): boolean {
  const now = opts.now ?? Date.now()
  const existing = leases.get(originSessionId)
  if (!isLive(existing, now)) return false
  if (opts.exemptRequestId !== undefined && existing.requestId === opts.exemptRequestId) return false
  return true
}

/** True only when `requestId` is the live lease owner for `originSessionId`. */
export function isRequestLeaseOwner(originSessionId: string, requestId: string, now = Date.now()): boolean {
  const existing = leases.get(originSessionId)
  return isLive(existing, now) && existing.requestId === requestId
}

export function getRemoteAgentLease(originSessionId: string, now = Date.now()): RemoteAgentLeaseSnapshot | undefined {
  const existing = leases.get(originSessionId)
  if (!isLive(existing, now)) return undefined
  return {
    originSessionId: existing.originSessionId,
    requestId: existing.requestId,
    startedAt: existing.startedAt,
    expiresAt: existing.expiresAt
  }
}

export function countRunningRemoteAgents(now = Date.now()): number {
  let count = 0
  for (const lease of leases.values()) {
    if (isLive(lease, now)) count++
  }
  return count
}

/** Force-reclaim expired leases (invoking their cancel handles). Returns the number reaped. */
export function reapExpiredRemoteSessions(now = Date.now()): number {
  let reaped = 0
  for (const [key, lease] of [...leases]) {
    if (lease.expiresAt > now) continue
    leases.delete(key)
    try {
      lease.cancel()
    } catch {
      /* ignore cancel handle errors */
    }
    reaped++
  }
  return reaped
}

/** Test-only: reset registry between tests. */
export function resetRunningRemoteAgentRegistryForTests(): void {
  leases.clear()
}
