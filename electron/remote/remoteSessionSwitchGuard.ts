import type { SwitchBlocker } from './remoteSessionSwitchState'
import { getSessionSwitchBlockers } from './remoteSessionSwitchState'
import {
  REMOTE_SESSION_SWITCH_BUSY_CALLER,
  REMOTE_SESSION_SWITCH_BUSY_TARGET
} from './remoteSessionGuardMessages'

export type SwitchSessionGuardResult =
  | { allowed: true }
  | {
      allowed: false
      error: string
      code: 'caller_busy' | 'target_busy'
      blockers: SwitchBlocker[]
    }

export type CanSwitchRemoteSessionOpts = {
  callerRequestId: string
  hasPendingConfirm: (sessionId: string) => boolean
}

export function canSwitchRemoteSession(
  callerSessionId: string,
  targetSessionId: string,
  opts: CanSwitchRemoteSessionOpts
): SwitchSessionGuardResult {
  const callerBlockers = getSessionSwitchBlockers(callerSessionId, {
    exemptRequestId: opts.callerRequestId,
    hasPendingConfirm: opts.hasPendingConfirm
  })
  if (callerBlockers.length > 0) {
    return {
      allowed: false,
      error: REMOTE_SESSION_SWITCH_BUSY_CALLER,
      code: 'caller_busy',
      blockers: callerBlockers
    }
  }

  if (targetSessionId !== callerSessionId) {
    const targetBlockers = getSessionSwitchBlockers(targetSessionId, {
      hasPendingConfirm: opts.hasPendingConfirm
    })
    if (targetBlockers.length > 0) {
      return {
        allowed: false,
        error: REMOTE_SESSION_SWITCH_BUSY_TARGET,
        code: 'target_busy',
        blockers: targetBlockers
      }
    }
  }

  return { allowed: true }
}
