import { createHash } from 'node:crypto'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'

type PreparedWorkDirs = Readonly<{
  input: Record<string, unknown>
  result: ToolExecutorResult
  callerBinding: Readonly<Record<string, unknown>>
  snapshotHash: string
}>

const REMOTE_KEYS = ['source', 'messageId', 'chatId', 'userId', 'authOwner', 'authorizationGeneration', 'workDirProfileId', 'requestId', 'originSessionId'] as const

function runtimeContext(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('LIST_WORKDIRS_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function callerBinding(runtime: RuntimeExecutionContext): Readonly<Record<string, unknown>> {
  return {
    sessionId: runtime.sessionId,
    lane: runtime.lane,
    ...(runtime.remoteContext ? Object.fromEntries(REMOTE_KEYS.flatMap((key) => {
      const value = runtime.remoteContext?.[key]
      return value === undefined ? [] : [[key, value]]
    })) : {})
  }
}

async function readSnapshot(executor: ToolExecutor, input: Record<string, unknown>, runtime: RuntimeExecutionContext, context: ToolExecutionContext): Promise<ToolExecutorResult> {
  return executor.execute(input, {
    ...runtime,
    requestId: context.requestId,
    toolUseId: context.toolUseId,
    signal: context.signal
  })
}

/** Freeze the read-only directory listing so confirmation and dispatch refer to the same remote session view. */
export function createListWorkDirsRegisteredTool(executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedWorkDirs, ToolExecutorResult>({
    name: 'list_work_dirs',
    actionClass: 'read',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
      const prototype = Object.getPrototypeOf(raw)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error('LIST_WORKDIRS_RUNTIME_CONTEXT_REQUIRED')
      const result = await executor.execute(input, {
        ...planning.executionContext,
        requestId: planning.requestId,
        toolUseId: planning.toolUseId,
        signal: planning.signal
      })
      return {
        input: structuredClone(input),
        result: structuredClone(result),
        callerBinding: callerBinding(planning.executionContext),
        snapshotHash: hash(result)
      }
    },
    validate: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      if (hash(callerBinding(runtime)) !== hash(prepared.callerBinding)) throw new Error('LIST_WORKDIRS_PREPARED_CALLER_CHANGED')
      const latest = await readSnapshot(executor, prepared.input, runtime, execution)
      if (hash(latest) !== prepared.snapshotHash) throw new Error('LIST_WORKDIRS_PREPARED_SNAPSHOT_CHANGED')
    },
    execute: async (prepared) => structuredClone(prepared.result),
    facts: ({ callerBinding: caller, snapshotHash }) => ({ callerBindingHash: hash(caller), snapshotHash }),
    display: ({ result }) => {
      const data = result.data as { directories?: readonly unknown[]; currentBoundId?: string } | undefined
      return { directoryCount: data?.directories?.length ?? 0, currentBoundId: data?.currentBoundId }
    }
  })
}
