import { validateReadExecutionPermit, type ReadExecutionPermit } from './readExecutionPermit'

export type ReadExecutionBoundaryInput = {
  toolName: string
  input: Record<string, unknown>
  requestId: string
  toolUseId: string
  permit?: ReadExecutionPermit
  expectedFacts?: ReadExecutionPermit['targets']
  targetKind?: 'file' | 'directory' | 'missing' | 'symlink' | 'special' | 'unknown'
}

export function validateReadExecutionBoundary(input: ReadExecutionBoundaryInput): { ok: true } | { ok: false; caseId: string } {
  if (input.toolName !== 'read_file' && input.toolName !== 'grep' && input.toolName !== 'list_directory' && input.toolName !== 'read_feishu_attachment') return { ok: true }
  if (!input.permit) return { ok: false, caseId: 'read-permit-missing' }
  return validateReadExecutionPermit(input.permit, {
    requestId: input.requestId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    input: input.input,
    facts: input.expectedFacts ?? input.permit.targets
  })
}
