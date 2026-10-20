import type { WritePathFact } from './extractors/writePathFacts'
import { createExecutionSubject, digestCanonicalExecutionValue, type ExecutionSubjectEnvelope } from '../../src/shared/security/executionSubject'
import type { AutomationRunOutputScope, TargetBinding } from '../../src/shared/automationTaskTypes'
import type { ExecutionLane } from '../../src/shared/confirmation/types'
import { matchesAutomationRunOutputWriteTarget, matchesBoundOutputWriteTarget } from '../butler/taskOutputDirectory'

export type AutomationOutputBindingAuthorization = {
  binding: Extract<TargetBinding, { kind: 'output' }>
  runOutputDir: string
}

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
  lane?: ExecutionLane
  automationOutputBinding?: AutomationOutputBindingAuthorization
  automationOutputScope?: AutomationRunOutputScope
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
  const automationOutputBinding = input.automationOutputBinding
    ? Object.freeze({ binding: Object.freeze({ ...input.automationOutputBinding.binding }), runOutputDir: input.automationOutputBinding.runOutputDir })
    : undefined
  const automationOutputScope = input.automationOutputScope ? Object.freeze({ ...input.automationOutputScope }) : undefined
  return Object.freeze({
    ...createExecutionSubject({ toolName: input.toolName, invocationId: input.requestId, toolUseId: input.toolUseId, subject: { input: input.input, target, decisionRuleId: input.decisionRuleId, approval: input.approval, lane: input.lane, decisionId: input.decisionId, policyDependencyFingerprint: input.policyDependencyFingerprint, ...(automationOutputBinding ? { automationOutputBinding } : {}), ...(automationOutputScope ? { automationOutputScope } : {}) } }),
    requestId: input.requestId, toolUseId: input.toolUseId, toolName: input.toolName, inputDigest: writeInputDigest(input.input),
    decisionId: input.decisionId, policyDependencyFingerprint: input.policyDependencyFingerprint, target, decisionRuleId: input.decisionRuleId, approval: input.approval, lane: input.lane,
    ...(automationOutputBinding ? { automationOutputBinding } : {}),
    ...(automationOutputScope ? { automationOutputScope } : {})
  })
}

export function validateWriteExecutionPermit(permit: WriteExecutionPermit | undefined, expected: {
  requestId: string; toolUseId: string; toolName: 'write_file' | 'edit_file'; input: unknown
}): { ok: true } | { ok: false; caseId: string } {
  if (!permit) return { ok: false, caseId: 'write-permit-missing' }
  if (permit.requestId !== expected.requestId || permit.toolUseId !== expected.toolUseId || permit.toolName !== expected.toolName) return { ok: false, caseId: 'write-permit-binding-mismatch' }
  if (permit.inputDigest !== writeInputDigest(expected.input)) return { ok: false, caseId: 'write-input-digest-mismatch' }
  const requiresAutomationOutputAuthorization = permit.lane === 'automation' || permit.decisionRuleId === 'automation-bound-output-write-allow'
  // final-check phase: re-resolve the signed output binding or output-directory scope at the write executor boundary;
  // a missing, stale, sensitive, unsupported, or out-of-archive target never reaches executor dispatch.
  if (requiresAutomationOutputAuthorization && !permit.automationOutputBinding && !permit.automationOutputScope) return { ok: false, caseId: 'automation-output-binding-missing' }
  if (!requiresAutomationOutputAuthorization && (permit.automationOutputBinding || permit.automationOutputScope)) return { ok: false, caseId: 'automation-output-binding-unexpected' }
  if (permit.automationOutputBinding) {
    const { binding, runOutputDir } = permit.automationOutputBinding
    if (permit.lane !== 'automation' || permit.decisionRuleId !== 'automation-bound-output-write-allow'
      || permit.approval !== 'auto-allow' || binding.kind !== 'output' || binding.resolverVersion !== 3) {
      return { ok: false, caseId: 'automation-output-binding-invalid' }
    }
    let targetMatches: boolean
    try {
      targetMatches = matchesBoundOutputWriteTarget(binding, runOutputDir, permit.target.normalizedPath)
    } catch {
      return { ok: false, caseId: 'automation-output-binding-invalid' }
    }
    if (!targetMatches || permit.target.zone === 'sensitive-file' || permit.target.zone === 'system-dir'
      || (permit.target.targetKind !== 'file' && permit.target.targetKind !== 'missing')
      || (expected.toolName === 'edit_file' && permit.target.targetKind !== 'file')) {
      return { ok: false, caseId: 'automation-output-target-mismatch' }
    }
  }
  if (permit.automationOutputScope) {
    if (permit.lane !== 'automation' || permit.decisionRuleId !== 'automation-bound-output-write-allow'
      || permit.approval !== 'auto-allow') return { ok: false, caseId: 'automation-output-scope-invalid' }
    if (!matchesAutomationRunOutputWriteTarget(permit.automationOutputScope, permit.target)
      || (expected.toolName === 'edit_file' && permit.target.targetKind !== 'file')) {
      return { ok: false, caseId: 'automation-output-scope-mismatch' }
    }
  }
  const currentSubject = createExecutionSubject({ toolName: expected.toolName, invocationId: expected.requestId, toolUseId: expected.toolUseId, subject: { input: expected.input, target: permit.target, decisionRuleId: permit.decisionRuleId, approval: permit.approval, lane: permit.lane, decisionId: permit.decisionId, policyDependencyFingerprint: permit.policyDependencyFingerprint, ...(permit.automationOutputBinding ? { automationOutputBinding: permit.automationOutputBinding } : {}), ...(permit.automationOutputScope ? { automationOutputScope: permit.automationOutputScope } : {}) } })
  if (permit.schemaVersion !== currentSubject.schemaVersion || permit.subjectDigest !== currentSubject.subjectDigest) return { ok: false, caseId: 'write-subject-digest-mismatch' }
  return { ok: true }
}
