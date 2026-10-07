import { createHash } from 'node:crypto'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'

type PreparedSessionSwitch = Readonly<{
  input: Record<string, unknown>
  snapshot: Readonly<{
    caller: Readonly<Record<string, unknown>>
    target: Readonly<Record<string, unknown>> | null
  }>
}>

function runtimeContext(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('REMOTE_SESSION_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function sessionSwitchSnapshot(input: Record<string, unknown>, runtime: RuntimeExecutionContext): PreparedSessionSwitch['snapshot'] {
  const remote = runtime.remoteContext
  const caller = {
    sessionId: runtime.sessionId,
    source: remote?.source,
    messageId: remote?.messageId,
    chatId: remote?.chatId,
    userId: remote?.userId,
    originSessionId: remote?.originSessionId
  }
  const targetId = typeof input.session_id === 'string' ? input.session_id.trim() : ''
  const targetSession = targetId && runtime.sessionQueries ? runtime.sessionQueries.readSession(targetId) : undefined
  if (!targetSession) return { caller, target: null }
  const metadata = targetSession.metadata as Record<string, unknown>
  const wechatMeta = metadata?.wechatMeta as Record<string, unknown> | undefined
  return {
    caller,
    target: {
      id: targetSession.id,
      name: targetSession.name,
      source: metadata?.source,
      feishuChatId: metadata?.feishuChatId,
      wechatUserId: wechatMeta?.userId,
      workDirProfileId: targetSession.workDirProfileId
    }
  }
}

function registerSwitchSession(executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedSessionSwitch, ToolExecutorResult>({
    name: 'switch_session',
    actionClass: 'read',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('SWITCH_SESSION_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error('REMOTE_SESSION_RUNTIME_CONTEXT_REQUIRED')
      return { input: structuredClone(input), snapshot: sessionSwitchSnapshot(input, planning.executionContext) }
    },
    validate: (prepared, execution) => {
      const current = sessionSwitchSnapshot(prepared.input, runtimeContext(execution))
      if (JSON.stringify(current) !== JSON.stringify(prepared.snapshot)) {
        throw new Error('REMOTE_SESSION_PREPARED_IDENTITY_CHANGED')
      }
    },
    execute: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      return executor.execute(prepared.input, {
        ...runtime,
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      })
    },
    facts: ({ snapshot }) => ({
      bindingHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    }),
    display: ({ snapshot }) => ({
      targetSession: snapshot.target ? { id: snapshot.target.id, name: snapshot.target.name } : undefined
    })
  })
}

/** Bind remote session switching to the caller and target identity captured during planning. */
export function createSwitchSessionRegisteredTool(executor: ToolExecutor): RegisteredTool {
  return registerSwitchSession(executor)
}
