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
  executionOutcome?: import('../../src/shared/domainTypes').ToolCallResultPersisted['executionOutcome']
  executorEntry?: import('../../src/shared/domainTypes').ToolCallResultPersisted['executorEntry']
  executionErrorCode?: string
  invocationDisposition?: import('../../src/shared/domainTypes').ToolCallResultPersisted['invocationDisposition']
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
    ...(record?.autoApprovedWrite && typeof record.autoApprovedWrite === 'object' && !Array.isArray(record.autoApprovedWrite)
      ? (() => {
          const meta = record.autoApprovedWrite as Record<string, unknown>
          const data = record.success === true && record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {}
          const path = typeof meta.path === 'string' ? meta.path : ''
          const statsAvailable = typeof data.bytesWritten === 'number' && Number.isFinite(data.bytesWritten) && typeof data.added === 'number' && Number.isFinite(data.added) && typeof data.removed === 'number' && Number.isFinite(data.removed)
          return path ? { autoApprovedWrite: { path, stats: statsAvailable ? 'available' as const : 'unavailable' as const,
            ...(statsAvailable ? { bytesWritten: data.bytesWritten as number, added: data.added as number, removed: data.removed as number } : {}) } } : {}
        })()
      : {})
  }, { ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}), processTool: isProcessToolName(input.toolName) })
  if (input.auditRef) result.auditRef = input.auditRef
  if (input.executionOutcome) result.executionOutcome = input.executionOutcome
  if (input.executorEntry) result.executorEntry = input.executorEntry
  if (input.executionErrorCode) result.executionErrorCode = input.executionErrorCode
  if (input.invocationDisposition) result.invocationDisposition = input.invocationDisposition
  if (input.deferredUnsurfaced && !input.isError && record?.success !== false) result.deferredUnsurfaced = true
  return result
}
