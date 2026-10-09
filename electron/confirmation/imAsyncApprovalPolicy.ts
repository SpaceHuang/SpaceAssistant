import type { ApprovalInvocationResult, ExecutionLane } from '../../src/shared/confirmation/types'

export type ImAsyncApprovalPolicyInput = {
  lane: ExecutionLane
  enabled: boolean
  ttlMs: number
  actionClass: 'read' | 'write' | 'execute' | 'outbound'
  gate: 'eligible' | 'config-error' | 'locked' | 'critical' | 'recursion-blocked'
  evidence: { kind: 'direct' | 'material' | 'incomplete'; restrictionsComplete: boolean }
  approval: ApprovalInvocationResult
  answererAvailable?: boolean
  /** Trusted user delegation digest only; untrusted material is deliberately not accepted here. */
  taskDigest?: string
  /** Test fixture only: models quoted/attached material and must never affect authorization. */
  untrustedMaterial?: string
  restrictionsTruncated?: boolean
}

export type ImAsyncApprovalDisposition =
  | { kind: 'agent-approved' }
  | { kind: 'deferred'; cause: 'agent-deny' | 'agent-undetermined' | 'unavailable' | 'timeout' | 'unparsable' | 'outbound-requires-human' | 'insufficient-delegation-evidence' }
  | { kind: 'deny'; cause: 'config-error' | 'locked' | 'critical' | 'recursion-blocked' | 'ttl-zero' | 'no-answerer' }
  | { kind: 'user-fallback' }

/** The final synchronous/async IM exit matrix. Never treats untrusted materials as delegation evidence. */
export function resolveImAsyncApprovalDisposition(input: ImAsyncApprovalPolicyInput): ImAsyncApprovalDisposition {
  if (input.lane === 'desktop' || input.lane === 'automation' || !input.enabled) return { kind: 'user-fallback' }
  if (input.gate !== 'eligible') return { kind: 'deny', cause: input.gate }
  if (input.ttlMs === 0) return { kind: 'deny', cause: 'ttl-zero' }
  if (input.answererAvailable === false) return { kind: 'deny', cause: 'no-answerer' }

  if (!input.approval.ok) {
    if (input.approval.cause === 'config-error') return { kind: 'deny', cause: 'config-error' }
    return { kind: 'deferred', cause: input.approval.cause }
  }
  if (input.approval.verdict.kind === 'deny') return { kind: 'deferred', cause: 'agent-deny' }
  if (input.approval.verdict.kind === 'undetermined') return { kind: 'deferred', cause: 'agent-undetermined' }

  if (input.actionClass === 'outbound') return { kind: 'deferred', cause: 'outbound-requires-human' }
  if (input.evidence.kind !== 'direct' || !input.evidence.restrictionsComplete || input.restrictionsTruncated) {
    return { kind: 'deferred', cause: 'insufficient-delegation-evidence' }
  }
  return { kind: 'agent-approved' }
}
