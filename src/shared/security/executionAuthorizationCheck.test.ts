import { describe, expect, it } from 'vitest'
import { checkExecutionAuthorization, type ExecutionAuthorizationCheckInput } from './executionAuthorizationCheck'

const base: ExecutionAuthorizationCheckInput = {
  policyDecision: { decisionId: 'decision-1', invocationId: 'inv-1', toolUseId: 'tool-1', dependencyFingerprint: 'sha256:policy-a', verdict: 'require-confirm', answerer: 'user' },
  currentDependencyFingerprint: 'sha256:policy-a',
  expectedSubject: { schemaVersion: 'subject-v1', subjectDigest: 'sha256:subject-a', toolName: 'send_message', invocationId: 'inv-1', toolUseId: 'tool-1' },
  currentSubject: { schemaVersion: 'subject-v1', subjectDigest: 'sha256:subject-a', toolName: 'send_message', invocationId: 'inv-1', toolUseId: 'tool-1' },
  receiptRequired: true,
  receipt: { receiptId: 'receipt-1', decisionId: 'decision-1', invocationId: 'inv-1', toolUseId: 'tool-1', dependencyFingerprint: 'sha256:policy-a', subjectDigest: 'sha256:subject-a', answerer: 'user' },
  permitRequired: true,
  permit: { permitId: 'permit-1', invocationId: 'inv-1', toolUseId: 'tool-1', subjectDigest: 'sha256:subject-a' },
  expectedAuthorizationGeneration: 4,
  currentAuthorizationGeneration: 4
}

describe('ExecutionAuthorizationCheck contract', () => {
  it('reports authorization for a current decision, bound receipt, permit and subject', () => {
    expect(checkExecutionAuthorization(base)).toEqual({ status: 'authorized', decisionId: 'decision-1', subjectDigest: 'sha256:subject-a' })
  })

  it.each([
    [{ policyDecision: { ...base.policyDecision, verdict: 'deny' as const }, receiptRequired: false }, { status: 'missing-authorization', failureCode: 'decision-not-authorizing' }],
    [{ receipt: undefined }, { status: 'missing-authorization', failureCode: 'receipt-required' }],
    [{ permit: undefined }, { status: 'missing-authorization', failureCode: 'permit-required' }],
    [{ currentDependencyFingerprint: 'sha256:policy-b' }, { status: 'stale-or-revoked', failureCode: 'policy-dependency-changed' }],
    [{ currentAuthorizationGeneration: 5 }, { status: 'stale-or-revoked', failureCode: 'authorization-generation-changed' }],
    [{ currentSubject: { ...base.currentSubject, subjectDigest: 'sha256:subject-b' } }, { status: 'subject-mismatch', failureCode: 'subject-changed' }],
    [{ receipt: { ...base.receipt!, answerer: 'agent' as const } }, { status: 'subject-mismatch', failureCode: 'receipt-binding-mismatch' }],
    [{ mechanismFailureCode: 'permit-store-unavailable' }, { status: 'mechanism-failure', failureCode: 'permit-store-unavailable' }]
  ] as const)('returns a stable non-policy failure category', (override, expected) => {
    expect(checkExecutionAuthorization({ ...base, ...override })).toEqual(expected)
  })

  it('does not return allow/confirm/deny actions or a risk level', () => {
    const result = checkExecutionAuthorization(base)
    expect(JSON.stringify(result)).not.toMatch(/allow|confirm|deny|risk/i)
  })
})
