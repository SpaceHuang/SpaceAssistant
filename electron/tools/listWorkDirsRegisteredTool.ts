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

/** Scope identity includes disclosed configuration only; session bindings are recomputed on every call. */
export function workDirDisclosureDigest(result: ToolExecutorResult): string | undefined {
  if (!result.success || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return undefined
  const data = result.data as { directories?: unknown }
  if (!Array.isArray(data.directories)) return undefined
  const directories: Array<{ id: string; name: string; path: string; isDefault: boolean; isSensitive: boolean; aliases: string[] }> = []
  for (const item of data.directories) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || typeof row.path !== 'string' ||
      typeof row.isDefault !== 'boolean' || typeof row.isSensitive !== 'boolean' ||
      !Array.isArray(row.aliases) || !row.aliases.every((alias) => typeof alias === 'string')) return undefined
    directories.push({ id: row.id, name: row.name, path: row.path, isDefault: row.isDefault, isSensitive: row.isSensitive,
      aliases: [...row.aliases as string[]].sort() })
  }
  directories.sort((a, b) => a.id.localeCompare(b.id))
  return hash(directories)
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
    facts: ({ callerBinding: caller, snapshotHash, result }) => {
      const reviewScopeDisclosureDigest = workDirDisclosureDigest(result)
      return { callerBindingHash: hash(caller), snapshotHash, ...(reviewScopeDisclosureDigest ? { reviewScopeDisclosureDigest } : {}) }
    },
    display: ({ result }) => {
      const data = result.data as { directories?: readonly unknown[]; currentBoundId?: string } | undefined
      return { directoryCount: data?.directories?.length ?? 0, currentBoundId: data?.currentBoundId }
    }
  })
}
