import { createHash } from 'crypto'
import type { WritePathFact } from './extractors/writePathFacts'

export type WriteExecutionPermit = {
  requestId: string
  toolUseId: string
  toolName: 'write_file' | 'edit_file'
  inputDigest: string
  target: WritePathFact
  decisionRuleId: string
  approval: 'auto-allow' | 'confirmed'
}

export function writeInputDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function buildWriteExecutionPermit(input: Omit<WriteExecutionPermit, 'inputDigest'> & { input: unknown }): WriteExecutionPermit {
  const absolute = input.target.normalizedPath.startsWith('/') || /^[a-z]:[\\/]/i.test(input.target.normalizedPath) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(input.target.normalizedPath)
  if (!input.requestId || !input.toolUseId || !input.decisionRuleId || !absolute) {
    throw new Error('INVALID_WRITE_PERMIT')
  }
  const target = Object.freeze({
    ...input.target,
    parentIdentity: Object.freeze({ ...input.target.parentIdentity }),
    ...(input.target.identity ? { identity: Object.freeze({ ...input.target.identity }) } : {})
  })
  return Object.freeze({ requestId: input.requestId, toolUseId: input.toolUseId, toolName: input.toolName, inputDigest: writeInputDigest(input.input), target, decisionRuleId: input.decisionRuleId, approval: input.approval })
}

export function validateWriteExecutionPermit(permit: WriteExecutionPermit | undefined, expected: {
  requestId: string; toolUseId: string; toolName: 'write_file' | 'edit_file'; input: unknown
}): { ok: true } | { ok: false; caseId: string } {
  if (!permit) return { ok: false, caseId: 'write-permit-missing' }
  if (permit.requestId !== expected.requestId || permit.toolUseId !== expected.toolUseId || permit.toolName !== expected.toolName) return { ok: false, caseId: 'write-permit-binding-mismatch' }
  if (permit.inputDigest !== writeInputDigest(expected.input)) return { ok: false, caseId: 'write-input-digest-mismatch' }
  return { ok: true }
}
