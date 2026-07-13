import {
  releaseRemoteSession,
  tryClaimRemoteSession
} from './remoteAgentRegistry'
import {
  REMOTE_PARALLEL_FULL_MESSAGE,
  REMOTE_SESSION_BUSY_MESSAGE
} from './remoteSessionGuardMessages'

export type ClaimOrReleaseOk = {
  ok: true
  release: () => void
}

export type ClaimOrReleaseBusy = {
  ok: false
  reason: 'session_busy' | 'parallel_full'
  message: string
}

export type ClaimOrReleaseResult = ClaimOrReleaseOk | ClaimOrReleaseBusy

/**
 * Claim a remote session slot; on success returns a release() for finally.
 * On failure selects the matching busy / parallel-full user-facing message.
 */
export function tryClaimOrRelease(sessionId: string, maxParallel: number): ClaimOrReleaseResult {
  const claim = tryClaimRemoteSession(sessionId, maxParallel)
  if (claim === 'ok') {
    return {
      ok: true,
      release: () => releaseRemoteSession(sessionId)
    }
  }
  return {
    ok: false,
    reason: claim,
    message: claim === 'session_busy' ? REMOTE_SESSION_BUSY_MESSAGE : REMOTE_PARALLEL_FULL_MESSAGE
  }
}
