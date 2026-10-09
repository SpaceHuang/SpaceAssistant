import { projectAgentToolResult, type AgentToolResultInput } from '../../src/shared/agentToolResult'
import { isProcessToolName } from '../../src/shared/processResultProjection'

/** Recomputes the safe SessionEvent result from the canonical SDK completion payload. */
export function projectCanonicalToolResultForSessionLedger(input: {
  rawResult: unknown
  isError: boolean
  toolName?: string
  workspaceRoot?: string
  auditRef?: string
  deferredUnsurfaced?: boolean
}): AgentToolResultInput {
  const record = input.rawResult && typeof input.rawResult === 'object' && !Array.isArray(input.rawResult)
    ? input.rawResult as Record<string, unknown>
    : undefined
  const result = projectAgentToolResult({
    success: typeof record?.success === 'boolean' ? record.success : !input.isError,
    ...('data' in (record ?? {}) ? { data: record!.data } : { data: input.rawResult }),
    ...(typeof record?.error === 'string' ? { error: record.error } : {}),
    ...(typeof record?.userMessage === 'string' ? { userMessage: record.userMessage } : {}),
    ...(typeof record?.decisionRuleId === 'string' ? { decisionRuleId: record.decisionRuleId } : {}),
    ...(record?.autoApprovedWrite && typeof record.autoApprovedWrite === 'object'
      ? { autoApprovedWrite: record.autoApprovedWrite as import('../../src/shared/domainTypes').AutoApprovedWriteMeta }
      : {})
  }, { ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}), processTool: isProcessToolName(input.toolName) })
  if (input.auditRef) result.auditRef = input.auditRef
  if (input.deferredUnsurfaced && !input.isError && record?.success !== false) result.deferredUnsurfaced = true
  return result
}
