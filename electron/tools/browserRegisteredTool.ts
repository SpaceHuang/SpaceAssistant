import { createHash } from 'node:crypto'
import type { BrowserConfig } from '../../src/shared/domainTypes'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'

type PreparedBrowserCall = Readonly<{
  input: Record<string, unknown>
  sessionId: string
  browserConfig?: BrowserConfig
  isRemote: boolean
  lane?: string
  toolUserConfirmed: boolean
}>

function currentRuntime(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('BROWSER_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function currentBinding(runtime: RuntimeExecutionContext): Omit<PreparedBrowserCall, 'input'> {
  return {
    sessionId: runtime.sessionId,
    ...(runtime.browserConfig ? { browserConfig: structuredClone(runtime.browserConfig) } : {}),
    isRemote: runtime.remoteContext !== undefined,
    ...(runtime.lane !== undefined ? { lane: runtime.lane } : {}),
    toolUserConfirmed: runtime.toolUserConfirmed === true
  }
}

function bindingDigest(binding: Omit<PreparedBrowserCall, 'input'>): string {
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex')
}

function preparedBinding(prepared: PreparedBrowserCall): Omit<PreparedBrowserCall, 'input'> {
  return {
    sessionId: prepared.sessionId,
    ...(prepared.browserConfig ? { browserConfig: prepared.browserConfig } : {}),
    isRemote: prepared.isRemote,
    ...(prepared.lane !== undefined ? { lane: prepared.lane } : {}),
    toolUserConfirmed: prepared.toolUserConfirmed
  }
}

/** Freeze browser policy/session state before confirmation and reject drift before dispatch. */
export function createBrowserRegisteredTool(executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedBrowserCall, ToolExecutorResult>({
    name: 'browser',
    actionClass: 'outbound',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('BROWSER_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error('BROWSER_RUNTIME_CONTEXT_REQUIRED')
      return { input: structuredClone(input), ...currentBinding(planning.executionContext) }
    },
    validate: (prepared, execution) => {
      const current = currentBinding(currentRuntime(execution))
      const expected = preparedBinding(prepared)
      // Confirmation is a legitimate monotonic host transition between planning and recheck.
      // Keep every other frozen browser fact exact, but let execution observe the approved state.
      const comparableCurrent = !expected.toolUserConfirmed && current.toolUserConfirmed
        ? { ...current, toolUserConfirmed: false }
        : current
      if (bindingDigest(comparableCurrent) !== bindingDigest(expected)) {
        throw new Error('BROWSER_PREPARED_POLICY_CHANGED')
      }
    },
    execute: async (prepared, execution) => {
      const runtime = currentRuntime(execution)
      return executor.execute(prepared.input, {
        ...runtime,
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        sessionId: prepared.sessionId,
        ...(prepared.browserConfig ? { browserConfig: structuredClone(prepared.browserConfig) } : { browserConfig: undefined }),
        ...(prepared.lane !== undefined ? { lane: prepared.lane } : {}),
        toolUserConfirmed: runtime.toolUserConfirmed === true,
        signal: execution.signal
      })
    },
    facts: (prepared) => ({ policySnapshotHash: bindingDigest(preparedBinding(prepared)) }),
    display: (prepared) => ({ action: typeof prepared.input.action === 'string' ? prepared.input.action : 'unknown' })
  })
}
