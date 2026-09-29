import { createHash } from 'node:crypto'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeExecutionContext, ToolExecutorResult } from './types'

type PreparedSnapshotRead = Readonly<{
  input: Record<string, unknown>
  result: ToolExecutorResult
  contextHash: string
  resultHash: string
}>

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const REMOTE_KEYS = ['source', 'messageId', 'chatId', 'userId', 'outboundSessionId', 'authOwner', 'authorizationGeneration', 'workDirProfileId', 'requestId', 'originSessionId'] as const

function readContext(runtime: RuntimeExecutionContext, identity: (value: object | undefined) => string): unknown {
  return {
    workDir: runtime.workDir,
    userDataDir: runtime.userDataDir,
    sessionId: runtime.sessionId,
    lane: runtime.lane,
    historyFactsHash: runtime.historyFacts ? hash(runtime.historyFacts) : undefined,
    appDatabaseIdentity: identity(runtime.appDatabase),
    workDirManagerIdentity: identity(runtime.workDirManager),
    remote: runtime.remoteContext ? Object.fromEntries(REMOTE_KEYS.flatMap((key) => {
      const value = runtime.remoteContext?.[key]
      return value === undefined ? [] : [[key, value]]
    })) : undefined
  }
}

async function invoke(
  executor: (input: Record<string, unknown>, context: RuntimeExecutionContext) => Promise<ToolExecutorResult>,
  input: Record<string, unknown>, runtime: RuntimeExecutionContext
): Promise<ToolExecutorResult> {
  return executor(input, runtime)
}

/** Turn a pure host read into a prepared snapshot whose context and result are revalidated before dispatch. */
export function createSnapshotReadRegisteredTool(
  name: string,
  executor: (input: Record<string, unknown>, context: RuntimeExecutionContext) => Promise<ToolExecutorResult>
): RegisteredTool {
  const parseInput = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    const prototype = Object.getPrototypeOf(raw)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
    return structuredClone(raw as Record<string, unknown>)
  }
  const identities = new WeakMap<object, number>()
  let nextIdentity = 1
  const identity = (value: object | undefined): string => {
    if (!value) return 'missing'
    const known = identities.get(value)
    if (known) return String(known)
    const created = nextIdentity++
    identities.set(value, created)
    return String(created)
  }
  return definePlannedTool<Record<string, unknown>, PreparedSnapshotRead, ToolExecutorResult>({
    name,
    actionClass: 'read',
    parseInput,
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error(`${name.toUpperCase().replaceAll('.', '_')}_RUNTIME_CONTEXT_REQUIRED`)
      const runtime = planning.executionContext
      const result = await invoke(executor, input, runtime)
      return { input: structuredClone(input), result: structuredClone(result), contextHash: hash(readContext(runtime, identity)), resultHash: hash(result) }
    },
    validate: async (prepared, execution) => {
      const runtime = execution.runtimeContext as RuntimeExecutionContext | undefined
      if (!runtime) throw new Error(`${name.toUpperCase().replaceAll('.', '_')}_RUNTIME_CONTEXT_REQUIRED`)
      if (hash(readContext(runtime, identity)) !== prepared.contextHash) throw new Error('SNAPSHOT_READ_CONTEXT_CHANGED')
      const latest = await invoke(executor, prepared.input, runtime)
      if (hash(latest) !== prepared.resultHash) throw new Error('SNAPSHOT_READ_RESULT_CHANGED')
    },
    execute: async (prepared) => structuredClone(prepared.result),
    facts: ({ contextHash, resultHash }) => ({ contextHash, resultHash }),
    display: ({ result }) => ({ toolName: name, success: result.success })
  })
}
