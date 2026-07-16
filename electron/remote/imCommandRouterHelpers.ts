import {
  releaseRemoteSession,
  tryClaimRemoteSession,
  type ClaimRemoteSessionOptions
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
 * Claim the remote agent run lease for (originSessionId, requestId); on success returns a
 * release() for finally. On failure selects the matching busy / parallel-full user-facing
 * message. Only the same requestId may release the lease it claimed.
 */
export function tryClaimOrRelease(
  originSessionId: string,
  requestId: string,
  maxParallel: number,
  opts?: ClaimRemoteSessionOptions
): ClaimOrReleaseResult {
  const claim = tryClaimRemoteSession(originSessionId, requestId, maxParallel, opts)
  if (claim === 'ok') {
    return {
      ok: true,
      release: () => releaseRemoteSession(originSessionId, requestId)
    }
  }
  return {
    ok: false,
    reason: claim,
    message: claim === 'session_busy' ? REMOTE_SESSION_BUSY_MESSAGE : REMOTE_PARALLEL_FULL_MESSAGE
  }
}

/**
 * Idempotent finalizer for IM processed-store claims (WP5).
 * Every path after tryClaim that does not start / finish the Agent must call complete().
 */
export function createProcessedClaimFinalizer(args: {
  messageId: string
  claimId: string | undefined
  markCompleted: (messageId: string, claimId: string, resultSummary: string) => Promise<boolean>
}): {
  complete: (resultSummary: string) => Promise<void>
  readonly done: boolean
} {
  let done = false
  return {
    get done() {
      return done
    },
    async complete(resultSummary: string): Promise<void> {
      if (!args.claimId || done) return
      done = true
      await args.markCompleted(args.messageId, args.claimId, resultSummary)
    }
  }
}
