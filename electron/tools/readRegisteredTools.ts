import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { validateReadExecutionBoundary } from '../confirmation/readExecutionBoundary'
import type { ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'

type ReadToolName = 'read_file' | 'list_directory' | 'grep' | 'read_feishu_attachment'
type PreparedRead = {
  input: Record<string, unknown>
  permit?: ReadExecutionPermit
}

function currentRuntime(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('READ_TOOL_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function permitSnapshot(permit: ReadExecutionPermit | undefined): ReadExecutionPermit | undefined {
  return permit ? structuredClone(permit) : undefined
}

function validateBoundary(
  name: ReadToolName,
  input: Record<string, unknown>,
  requestId: string,
  toolUseId: string,
  permit: ReadExecutionPermit | undefined
): void {
  const result = validateReadExecutionBoundary({
    toolName: name,
    input,
    requestId,
    toolUseId,
    permit,
    targetKind: permit?.targets[0]?.targetKind,
    expectedFacts: permit?.targets
  })
  if (!result.ok) throw new Error(result.caseId)
}

function registerReadTool(name: ReadToolName, executor: ToolExecutor): RegisteredTool {
  const boundPermits = new WeakMap<PreparedRead, ReadExecutionPermit>()
  return definePlannedTool<Record<string, unknown>, PreparedRead, ToolExecutorResult>({
    name,
    actionClass: 'read',
    ...(executor.resourceKeys ? { resourceKeys: (input, context) => context ? executor.resourceKeys!(input, context) : undefined } : {}),
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('READ_TOOL_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      const runtime = planning.executionContext
      if (!runtime) throw new Error('READ_TOOL_RUNTIME_CONTEXT_REQUIRED')
      const permit = runtime.readExecutionPermit
      if (permit) validateBoundary(name, input, planning.requestId, planning.toolUseId, permit)
      // Hosted SDK plans before its initial SafetyPolicy evaluation. The host may attach the
      // gate-issued structural permit afterward; bind it during the first fresh recheck.
      return { input: structuredClone(input), ...(permit ? { permit: permitSnapshot(permit)! } : {}) }
    },
    validate: (prepared, execution) => {
      const permit = currentRuntime(execution).readExecutionPermit
      if (!permit) throw new Error('read-permit-missing')
      const bound = boundPermits.get(prepared) ?? prepared.permit
      if (!bound) boundPermits.set(prepared, permitSnapshot(permit)!)
      else if (JSON.stringify(permitSnapshot(permit)) !== JSON.stringify(bound)) {
        throw new Error('READ_PREPARED_PERMIT_CHANGED')
      }
      validateBoundary(name, prepared.input, execution.requestId, execution.toolUseId, permit)
    },
    execute: async (prepared, execution) => {
      const runtime = currentRuntime(execution)
      return executor.execute(prepared.input, {
        ...runtime,
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      })
    },
    facts: (prepared) => ({
      inputDigest: prepared.permit?.inputDigest ?? null,
      targets: (prepared.permit?.targets ?? []).map(({ factId, decisionRuleId, normalizedPath, zone, targetKind, resolvedKind, scope, identity, directoryGrant }) => ({
        factId, decisionRuleId, normalizedPath, zone, targetKind,
        ...(resolvedKind ? { resolvedKind } : {}),
        ...(scope ? { scope } : {}),
        ...(identity ? { identity } : {}),
        ...(directoryGrant ? { directoryGrantId: directoryGrant.grantId, directoryGrantSessionId: directoryGrant.sessionId, authorizationSource: 'user-selected-directory' } : {})
      }))
    }),
    display: (prepared) => ({
      toolName: name,
      targets: (prepared.permit?.targets ?? []).map(({ factId, zone, targetKind, directoryGrant }) => ({ factId, zone, targetKind, ...(directoryGrant ? { authorizationSource: 'user-selected-directory', directoryGrantId: directoryGrant.grantId } : {}) }))
    })
  })
}

/** Read adapters bind immutable input and the host's structural ReadExecutionPermit before dispatch. */
export function createReadRegisteredTools(executors: {
  readFile: ToolExecutor
  listDirectory: ToolExecutor
  grep: ToolExecutor
  readFeishuAttachment: ToolExecutor
}): readonly RegisteredTool[] {
  return [
    registerReadTool('read_file', executors.readFile),
    registerReadTool('list_directory', executors.listDirectory),
    registerReadTool('grep', executors.grep),
    registerReadTool('read_feishu_attachment', executors.readFeishuAttachment)
  ]
}
