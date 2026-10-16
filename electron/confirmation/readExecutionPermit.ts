import path from 'path'
import { createExecutionSubject, digestCanonicalExecutionValue, type ExecutionSubjectEnvelope } from '../../src/shared/security/executionSubject'
import type { PathZone } from '../../src/shared/confirmation/types'
import type { SessionDirectoryGrantRecord } from '../../src/shared/sessionDirectoryGrant'

export type ReadPermitIdentity = { dev: number; ino: number; mode: number; size: number; mtimeMs: number }
// subtree：grep 目录递归 permit——绑定根目录 identity 并递归读取其子树（§5.2）
export type ReadPermitScope = 'single-target' | 'direct-entries' | 'subtree'
export type ReadPermitTarget = { factId: string; decisionRuleId: string; normalizedPath: string; zone: PathZone; targetKind: 'file' | 'directory' | 'missing' | 'symlink' | 'special' | 'unknown'; resolvedKind?: 'file' | 'directory' | 'special'; scope?: ReadPermitScope; identity?: ReadPermitIdentity; directoryGrant?: Pick<SessionDirectoryGrantRecord, 'grantId' | 'sessionId' | 'realPath' | 'identity'>; /** wiki 挂载命中时的词汇路径（T1.8；审批卡片/审计展示用） */ vocabularyPath?: string }
export type ReadPermitInput = { decisionRuleId?: string; decisionId?: string; policyDependencyFingerprint?: string; requestId: string; toolUseId: string; toolName: 'read_file' | 'grep' | 'list_directory' | 'read_feishu_attachment'; input: Record<string, unknown>; facts: ReadPermitTarget[] }
export type ReadExecutionPermit = ReadPermitInput & ExecutionSubjectEnvelope & { inputDigest: string; targets: ReadPermitTarget[] }

function isAbsoluteReadTargetPath(value: string): boolean {
  // permit 在 renderer-free 的跨平台校验中会接收 gate 产生的平台原生路径。
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

export function readInputDigest(value: unknown): string {
  return digestCanonicalExecutionValue(value)
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    freezeDeep((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

export function buildReadExecutionPermit(input: ReadPermitInput): ReadExecutionPermit {
  const factIds = input.facts.map((fact) => fact.factId)
  const ruleIds = [...new Set(input.facts.map((fact) => fact.decisionRuleId))]
  if (!input.requestId || !input.toolUseId || input.facts.length === 0 || new Set(factIds).size !== factIds.length || ruleIds.length !== 1 || (input.decisionRuleId !== undefined && input.decisionRuleId !== ruleIds[0]) || input.facts.some((fact) => !fact.factId || typeof fact.normalizedPath !== 'string' || !isAbsoluteReadTargetPath(fact.normalizedPath) || !fact.decisionRuleId || ['unknown', 'default', 'placeholder'].includes(fact.decisionRuleId) || (fact.vocabularyPath !== undefined && (typeof fact.vocabularyPath !== 'string' || fact.vocabularyPath.length === 0)))) throw new Error('INVALID_READ_PERMIT_TARGET')
  const inputSnapshot = freezeDeep(structuredClone(input.input))
  const targets = Object.freeze(input.facts.map((fact) => freezeDeep(structuredClone(fact)))) as unknown as ReadPermitTarget[]
  const subject = createExecutionSubject({ toolName: input.toolName, invocationId: input.requestId, toolUseId: input.toolUseId, subject: { input: input.input, targets: input.facts, decisionId: input.decisionId, policyDependencyFingerprint: input.policyDependencyFingerprint } })
  return Object.freeze({
    ...input,
    schemaVersion: subject.schemaVersion,
    subjectDigest: subject.subjectDigest,
    invocationId: subject.invocationId,
    input: inputSnapshot,
    facts: targets,
    inputDigest: readInputDigest(inputSnapshot),
    targets
  })
}

export function validateReadExecutionPermit(permit: ReadExecutionPermit, expected: ReadPermitInput): { ok: true } | { ok: false; caseId: string } {
  if (permit.requestId !== expected.requestId || permit.toolUseId !== expected.toolUseId || permit.toolName !== expected.toolName) return { ok: false, caseId: 'permit-binding-mismatch' }
  if (permit.inputDigest !== readInputDigest(expected.input)) return { ok: false, caseId: 'input-digest-mismatch' }
  if (permit.targets.length !== expected.facts.length || permit.targets.some((target, i) => JSON.stringify(target) !== JSON.stringify(expected.facts[i]))) return { ok: false, caseId: 'fact-target-mismatch' }
  const currentSubject = createExecutionSubject({ toolName: expected.toolName, invocationId: expected.requestId, toolUseId: expected.toolUseId, subject: { input: expected.input, targets: expected.facts, decisionId: permit.decisionId, policyDependencyFingerprint: permit.policyDependencyFingerprint } })
  if (permit.schemaVersion !== currentSubject.schemaVersion || permit.subjectDigest !== currentSubject.subjectDigest) return { ok: false, caseId: 'subject-digest-mismatch' }
  return { ok: true }
}

import type { ReadConfirmationRegistry } from './readConfirmationRegistry'

export function buildUserConfirmedReadExecutionPermit(input: ReadPermitInput, registry: ReadConfirmationRegistry): ReadExecutionPermit {
  const targetRuleIds = [...new Set(input.facts.map((fact) => fact.decisionRuleId))]
  const expectedRuleId = input.decisionRuleId ?? (targetRuleIds.length === 1 ? targetRuleIds[0] : undefined)
  const entry = registry.consume(input.requestId, input.toolUseId, {
    inputDigest: readInputDigest(input.input),
    factIds: input.facts.map((fact) => fact.factId),
    ruleId: expectedRuleId
  })
  if (!entry || entry.toolUseId !== input.toolUseId || entry.inputDigest !== readInputDigest(input.input) || entry.factIds.length !== input.facts.length || entry.factIds.some((id, i) => id !== input.facts[i]?.factId) || input.facts.some((fact) => fact.decisionRuleId !== entry.ruleId)) {
    throw new Error('READ_CONFIRMATION_NOT_APPROVED')
  }
  return buildReadExecutionPermit({ ...input, decisionRuleId: entry.ruleId })
}
