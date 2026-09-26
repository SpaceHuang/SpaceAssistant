import { createHash } from 'crypto'
import path from 'path'
import type { PathZone } from '../../src/shared/confirmation/types'

export type ReadPermitIdentity = { dev: number; ino: number; mode: number; size: number; mtimeMs: number }
export type ReadPermitScope = 'single-target' | 'direct-entries'
export type ReadPermitTarget = { factId: string; decisionRuleId: string; normalizedPath: string; zone: PathZone; targetKind: 'file' | 'directory' | 'missing' | 'symlink' | 'special' | 'unknown'; resolvedKind?: 'file' | 'directory' | 'special'; scope?: ReadPermitScope; identity?: ReadPermitIdentity }
export type ReadPermitInput = { decisionRuleId?: string; requestId: string; toolUseId: string; toolName: 'read_file' | 'grep' | 'list_directory' | 'read_feishu_attachment'; input: Record<string, unknown>; facts: ReadPermitTarget[] }
export type ReadExecutionPermit = ReadPermitInput & { inputDigest: string; targets: ReadPermitTarget[] }

function isAbsoluteReadTargetPath(value: string): boolean {
  // permit 在 renderer-free 的跨平台校验中会接收 gate 产生的平台原生路径。
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

export function readInputDigest(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize)
    if (input !== null && typeof input === 'object') {
      const record = input as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]))
    }
    return input
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export function buildReadExecutionPermit(input: ReadPermitInput): ReadExecutionPermit {
  const factIds = input.facts.map((fact) => fact.factId)
  const ruleIds = [...new Set(input.facts.map((fact) => fact.decisionRuleId))]
  if (!input.requestId || !input.toolUseId || input.facts.length === 0 || new Set(factIds).size !== factIds.length || ruleIds.length !== 1 || (input.decisionRuleId !== undefined && input.decisionRuleId !== ruleIds[0]) || input.facts.some((fact) => !fact.factId || typeof fact.normalizedPath !== 'string' || !isAbsoluteReadTargetPath(fact.normalizedPath) || !fact.decisionRuleId || ['unknown', 'default', 'placeholder'].includes(fact.decisionRuleId))) throw new Error('INVALID_READ_PERMIT_TARGET')
  return Object.freeze({ ...input, inputDigest: readInputDigest(input.input), targets: input.facts.map((fact) => Object.freeze({ ...fact })) })
}

export function validateReadExecutionPermit(permit: ReadExecutionPermit, expected: ReadPermitInput): { ok: true } | { ok: false; caseId: string } {
  if (permit.requestId !== expected.requestId || permit.toolUseId !== expected.toolUseId || permit.toolName !== expected.toolName) return { ok: false, caseId: 'permit-binding-mismatch' }
  if (permit.inputDigest !== readInputDigest(expected.input)) return { ok: false, caseId: 'input-digest-mismatch' }
  if (permit.targets.length !== expected.facts.length || permit.targets.some((target, i) => JSON.stringify(target) !== JSON.stringify(expected.facts[i]))) return { ok: false, caseId: 'fact-target-mismatch' }
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
