import { definePlannedTool, type RegisteredTool, type ToolPlanningContext, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutor, ToolExecutionContext as RuntimeExecutionContext, ToolExecutorResult } from './types'
import { validateWriteExecutionPermit, type WriteExecutionPermit } from '../confirmation/writeExecutionPermit'
import { recordPolicyExecutionVeto } from '../confirmation/audit'

type WriteToolName = 'write_file' | 'edit_file'
type PermitSnapshot = Pick<WriteExecutionPermit, 'requestId' | 'invocationId' | 'toolUseId' | 'toolName' | 'inputDigest' | 'decisionId' | 'policyDependencyFingerprint' | 'subjectDigest' | 'schemaVersion' | 'decisionRuleId' | 'approval'> & {
  target: WriteExecutionPermit['target']
}
type PreparedWrite = Readonly<{
  input: Record<string, unknown>
  permit?: PermitSnapshot
}>

function currentRuntime(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('WRITE_TOOL_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function auditPermitVeto(runtime: RuntimeExecutionContext, name: WriteToolName, permit: WriteExecutionPermit | undefined, caseId: string): void {
  recordPolicyExecutionVeto({ audit: runtime.audit, lane: (runtime.lane as import('../../src/shared/confirmation/types').ExecutionLane | undefined) ?? 'desktop',
    sessionId: runtime.sessionId, requestId: runtime.requestId, toolUseId: runtime.toolUseId, toolName: name,
    decisionId: permit?.decisionId, decisionRuleId: permit?.decisionRuleId, failureClass: 'integration-violation', caseId, invariantId: 'SYS-PERMIT-001' })
}

function snapshotPermit(permit: WriteExecutionPermit | undefined): PermitSnapshot | undefined {
  if (!permit) return undefined
  return structuredClone({
    requestId: permit.requestId,
    invocationId: permit.invocationId,
    toolUseId: permit.toolUseId,
    toolName: permit.toolName,
    inputDigest: permit.inputDigest,
    decisionId: permit.decisionId,
    policyDependencyFingerprint: permit.policyDependencyFingerprint,
    subjectDigest: permit.subjectDigest,
    schemaVersion: permit.schemaVersion,
    decisionRuleId: permit.decisionRuleId,
    approval: permit.approval,
    target: permit.target
  })
}

function stablePermitSnapshot(permit: PermitSnapshot | undefined): string {
  return JSON.stringify(permit ?? null)
}

function registerWriteTool(name: WriteToolName, executor: ToolExecutor): RegisteredTool {
  const boundPermits = new WeakMap<PreparedWrite, PermitSnapshot>()
  return definePlannedTool<Record<string, unknown>, PreparedWrite, ToolExecutorResult>({
    name,
    actionClass: 'write',
    ...(executor.resourceKeys ? { resourceKeys: (input, context) => context ? executor.resourceKeys!(input, context) : undefined } : {}),
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('WRITE_TOOL_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning: ToolPlanningContext) => {
      const runtime = planning.executionContext
      if (!runtime) throw new Error('WRITE_TOOL_RUNTIME_CONTEXT_REQUIRED')
      const permit = runtime.writeExecutionPermit
      if (permit) {
        const valid = validateWriteExecutionPermit(permit, {
          requestId: planning.requestId,
          toolUseId: planning.toolUseId,
          toolName: name,
          input
        })
        if (!valid.ok) throw new Error(valid.caseId)
      }
      return { input: structuredClone(input), ...(permit ? { permit: snapshotPermit(permit)! } : {}) }
    },
    validate: (prepared, execution) => {
      const runtime = currentRuntime(execution)
      const permit = runtime.writeExecutionPermit
      if (!permit) {
        auditPermitVeto(runtime, name, undefined, 'write-permit-missing')
        throw new Error('write-permit-missing')
      }
      const bound = boundPermits.get(prepared) ?? prepared.permit
      if (!bound) boundPermits.set(prepared, snapshotPermit(permit)!)
      else if (stablePermitSnapshot(snapshotPermit(permit)) !== stablePermitSnapshot(bound)) {
        auditPermitVeto(runtime, name, permit, 'write-prepared-permit-changed')
        throw new Error('WRITE_PREPARED_PERMIT_CHANGED')
      }
      const valid = validateWriteExecutionPermit(permit, {
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        toolName: name,
        input: prepared.input
      })
      if (!valid.ok) {
        auditPermitVeto(runtime, name, permit, valid.caseId)
        throw new Error(valid.caseId)
      }
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
      inputDigest: prepared.permit?.inputDigest,
      decisionRuleId: prepared.permit?.decisionRuleId,
      target: prepared.permit?.target
    }),
    display: (prepared) => ({
      toolName: name,
      path: typeof prepared.input.path === 'string' ? prepared.input.path : typeof prepared.input.file_path === 'string' ? prepared.input.file_path : prepared.input.filePath,
      targetPath: prepared.permit?.target.normalizedPath,
      approval: prepared.permit?.approval
    })
  })
}

/** Planned adapters bind write inputs to the existing host target permit and recheck it before dispatch. */
export function createWriteFileRegisteredTools(executors: {
  writeFile: ToolExecutor
  editFile: ToolExecutor
}): readonly RegisteredTool[] {
  return [
    registerWriteTool('write_file', executors.writeFile),
    registerWriteTool('edit_file', executors.editFile)
  ]
}
