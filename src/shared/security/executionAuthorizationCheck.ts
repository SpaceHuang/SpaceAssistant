import type { PolicyDecision } from '../policy/policyDecision'

export interface ApprovalReceiptBinding {
  readonly receiptId: string
  readonly decisionId: string
  readonly invocationId: string
  readonly toolUseId: string
  readonly dependencyFingerprint: string
  readonly subjectDigest: string
  readonly answerer: 'user' | 'agent'
}

export interface ExecutionPermitBinding {
  readonly permitId: string
  readonly invocationId: string
  readonly toolUseId: string
  readonly subjectDigest: string
}

/** Minimal, opaque subject identity shared by pre-execution adapters. */
export interface ExecutionSubjectEnvelope {
  readonly schemaVersion: string
  readonly subjectDigest: string
  readonly toolName: string
  readonly invocationId: string
  readonly toolUseId: string
}

export interface ExecutionAuthorizationCheckInput {
  readonly policyDecision: Pick<PolicyDecision, 'decisionId' | 'invocationId' | 'toolUseId' | 'dependencyFingerprint' | 'verdict' | 'answerer'>
  readonly currentDependencyFingerprint: string
  readonly expectedSubject: ExecutionSubjectEnvelope
  readonly currentSubject: ExecutionSubjectEnvelope
  readonly receiptRequired: boolean
  readonly receipt?: ApprovalReceiptBinding
  readonly permitRequired: boolean
  readonly permit?: ExecutionPermitBinding
  readonly expectedAuthorizationGeneration?: number
  readonly currentAuthorizationGeneration?: number
  readonly mechanismFailureCode?: string
}

export type ExecutionAuthorizationCheckResult =
  | Readonly<{ status: 'authorized'; decisionId: string; subjectDigest: string }>
  | Readonly<{ status: 'missing-authorization'; failureCode: 'decision-not-authorizing' | 'receipt-required' | 'permit-required' }>
  | Readonly<{ status: 'subject-mismatch'; failureCode: 'receipt-binding-mismatch' | 'permit-binding-mismatch' | 'subject-changed' }>
  | Readonly<{ status: 'stale-or-revoked'; failureCode: 'policy-dependency-changed' | 'authorization-generation-changed' }>
  | Readonly<{ status: 'mechanism-failure'; failureCode: string }>

/** Check authorization existence, freshness and exact-object binding; never computes policy risk. */
export function checkExecutionAuthorization(input: ExecutionAuthorizationCheckInput): ExecutionAuthorizationCheckResult {
  if (input.mechanismFailureCode) return { status: 'mechanism-failure', failureCode: input.mechanismFailureCode }
  if (input.policyDecision.verdict === 'deny' || input.policyDecision.verdict === 'require-confirm' && !input.receiptRequired) {
    return { status: 'missing-authorization', failureCode: 'decision-not-authorizing' }
  }
  if (input.policyDecision.dependencyFingerprint !== input.currentDependencyFingerprint) {
    return { status: 'stale-or-revoked', failureCode: 'policy-dependency-changed' }
  }
  if (input.expectedAuthorizationGeneration !== undefined && input.currentAuthorizationGeneration !== input.expectedAuthorizationGeneration) {
    return { status: 'stale-or-revoked', failureCode: 'authorization-generation-changed' }
  }
  if (input.expectedSubject.schemaVersion !== input.currentSubject.schemaVersion ||
      input.expectedSubject.subjectDigest !== input.currentSubject.subjectDigest ||
      input.expectedSubject.toolName !== input.currentSubject.toolName ||
      input.expectedSubject.invocationId !== input.currentSubject.invocationId ||
      input.expectedSubject.toolUseId !== input.currentSubject.toolUseId) {
    return { status: 'subject-mismatch', failureCode: 'subject-changed' }
  }
  if (input.receiptRequired) {
    const receipt = input.receipt
    if (!receipt) return { status: 'missing-authorization', failureCode: 'receipt-required' }
    if (receipt.decisionId !== input.policyDecision.decisionId || receipt.invocationId !== input.policyDecision.invocationId ||
        receipt.toolUseId !== input.policyDecision.toolUseId || receipt.dependencyFingerprint !== input.currentDependencyFingerprint ||
        receipt.subjectDigest !== input.expectedSubject.subjectDigest ||
        input.policyDecision.answerer !== undefined && receipt.answerer !== input.policyDecision.answerer) {
      return { status: 'subject-mismatch', failureCode: 'receipt-binding-mismatch' }
    }
  }
  if (input.permitRequired) {
    const permit = input.permit
    if (!permit) return { status: 'missing-authorization', failureCode: 'permit-required' }
    if (permit.invocationId !== input.policyDecision.invocationId || permit.toolUseId !== input.policyDecision.toolUseId ||
        permit.subjectDigest !== input.expectedSubject.subjectDigest) {
      return { status: 'subject-mismatch', failureCode: 'permit-binding-mismatch' }
    }
  }
  return { status: 'authorized', decisionId: input.policyDecision.decisionId, subjectDigest: input.expectedSubject.subjectDigest }
}
