import type { WritePathFact } from './extractors/writePathFacts'
import { createExecutionSubject, digestCanonicalExecutionValue, type ExecutionSubjectEnvelope } from '../../src/shared/security/executionSubject'

export type WriteExecutionPermit = ExecutionSubjectEnvelope & {
  requestId: string
  toolUseId: string
  toolName: 'write_file' | 'edit_file'
  inputDigest: string
  decisionId?: string
  policyDependencyFingerprint?: string
  target: WritePathFact
  decisionRuleId: string
  approval: 'auto-allow' | 'confirmed'
}

export function writeInputDigest(value: unknown): string {
  return digestCanonicalExecutionValue(value)
}

export function buildWriteExecutionPermit(input: Omit<WriteExecutionPermit, 'inputDigest' | 'schemaVersion' | 'subjectDigest' | 'invocationId'> & { input: unknown }): WriteExecutionPermit {
  const absolute = input.target.normalizedPath.startsWith('/') || /^[a-z]:[\\/]/i.test(input.target.normalizedPath) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(input.target.normalizedPath)
  if (!input.requestId || !input.toolUseId || !input.decisionRuleId || !absolute) {
    throw new Error('INVALID_WRITE_PERMIT')
  }
  const target = Object.freeze({
    ...input.target,
    parentIdentity: Object.freeze({ ...input.target.parentIdentity }),
    ...(input.target.identity ? { identity: Object.freeze({ ...input.target.identity }) } : {})
  })
  return Object.freeze({
    ...createExecutionSubject({ toolName: input.toolName, invocationId: input.requestId, toolUseId: input.toolUseId, subject: { input: input.input, target, decisionRuleId: input.decisionRuleId, approval: input.approval, decisionId: input.decisionId, policyDependencyFingerprint: input.policyDependencyFingerprint } }),
    requestId: input.requestId, toolUseId: input.toolUseId, toolName: input.toolName, inputDigest: writeInputDigest(input.input),
    decisionId: input.decisionId, policyDependencyFingerprint: input.policyDependencyFingerprint, target, decisionRuleId: input.decisionRuleId, approval: input.approval
  })
}

export function validateWriteExecutionPermit(permit: WriteExecutionPermit | undefined, expected: {
  requestId: string; toolUseId: string; toolName: 'write_file' | 'edit_file'; input: unknown
}): { ok: true } | { ok: false; caseId: string } {
  if (!permit) return { ok: false, caseId: 'write-permit-missing' }
  if (permit.requestId !== expected.requestId || permit.toolUseId !== expected.toolUseId || permit.toolName !== expected.toolName) return { ok: false, caseId: 'write-permit-binding-mismatch' }
  if (permit.inputDigest !== writeInputDigest(expected.input)) return { ok: false, caseId: 'write-input-digest-mismatch' }
  const currentSubject = createExecutionSubject({ toolName: expected.toolName, invocationId: expected.requestId, toolUseId: expected.toolUseId, subject: { input: expected.input, target: permit.target, decisionRuleId: permit.decisionRuleId, approval: permit.approval, decisionId: permit.decisionId, policyDependencyFingerprint: permit.policyDependencyFingerprint } })
  if (permit.schemaVersion !== currentSubject.schemaVersion || permit.subjectDigest !== currentSubject.subjectDigest) return { ok: false, caseId: 'write-subject-digest-mismatch' }
  return { ok: true }
}
