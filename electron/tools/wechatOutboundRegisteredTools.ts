import { createHash } from 'node:crypto'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { RemoteContext, ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'

const REMOTE_BINDING_KEYS = [
  'source', 'messageId', 'chatId', 'userId', 'outboundSessionId', 'authOwner',
  'authorizationGeneration', 'workDirProfileId', 'requestId', 'originSessionId'
] as const

type RemoteBinding = Readonly<Record<string, unknown>>
type PreparedOutbound = Readonly<{
  input: Record<string, unknown>
  workDir: string
  sessionId: string
  lane?: string
  remoteContextPresent: boolean
  remoteBinding?: RemoteBinding
  wechatConfig?: WeChatConfig
}>

function runtimeContext(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('WECHAT_OUTBOUND_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function remoteBinding(remote: RemoteContext | undefined): RemoteBinding | undefined {
  if (!remote) return undefined
  return Object.fromEntries(REMOTE_BINDING_KEYS.flatMap((key) =>
    remote[key] === undefined ? [] : [[key, remote[key]]]
  ))
}

function snapshot(runtime: RuntimeExecutionContext): Omit<PreparedOutbound, 'input'> {
  return {
    workDir: runtime.workDir,
    sessionId: runtime.sessionId,
    ...(runtime.lane !== undefined ? { lane: runtime.lane } : {}),
    remoteContextPresent: runtime.remoteContext !== undefined,
    ...(remoteBinding(runtime.remoteContext) ? { remoteBinding: remoteBinding(runtime.remoteContext)! } : {}),
    ...(runtime.wechatConfig ? { wechatConfig: structuredClone(runtime.wechatConfig) } : {})
  }
}

function fingerprint(value: Omit<PreparedOutbound, 'input'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function preparedSnapshot(prepared: PreparedOutbound): Omit<PreparedOutbound, 'input'> {
  return {
    workDir: prepared.workDir,
    sessionId: prepared.sessionId,
    ...(prepared.lane !== undefined ? { lane: prepared.lane } : {}),
    remoteContextPresent: prepared.remoteContextPresent,
    ...(prepared.remoteBinding ? { remoteBinding: prepared.remoteBinding } : {}),
    ...(prepared.wechatConfig ? { wechatConfig: prepared.wechatConfig } : {})
  }
}

function registerOutbound(name: 'wechat_send' | 'wechat_reply', executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedOutbound, ToolExecutorResult>({
    name,
    actionClass: 'outbound',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('WECHAT_OUTBOUND_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error('WECHAT_OUTBOUND_RUNTIME_CONTEXT_REQUIRED')
      return { input: structuredClone(input), ...snapshot(planning.executionContext) }
    },
    validate: (prepared, execution) => {
      const current = snapshot(runtimeContext(execution))
      if (fingerprint(current) !== fingerprint(preparedSnapshot(prepared))) {
        throw new Error('WECHAT_OUTBOUND_PREPARED_BINDING_CHANGED')
      }
    },
    execute: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      const remoteContext = runtime.remoteContext && prepared.remoteBinding
        ? { ...runtime.remoteContext, ...prepared.remoteBinding } as RemoteContext
        : runtime.remoteContext
      return executor.execute(prepared.input, {
        ...runtime,
        workDir: prepared.workDir,
        sessionId: prepared.sessionId,
        ...(prepared.lane !== undefined ? { lane: prepared.lane } : {}),
        ...(remoteContext ? { remoteContext } : {}),
        ...(prepared.wechatConfig ? { wechatConfig: structuredClone(prepared.wechatConfig) } : {}),
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      })
    },
    facts: (prepared) => ({
      bindingHash: fingerprint(preparedSnapshot(prepared)),
      inputHash: createHash('sha256').update(JSON.stringify(prepared.input)).digest('hex')
    }),
    display: (prepared) => ({
      toolName: name,
      recipient: name === 'wechat_send' && typeof prepared.input.userId === 'string' ? prepared.input.userId : undefined
    })
  })
}

/** Freeze recipient/session/config facts for WeChat outbound effects before dispatch. */
export function createWeChatOutboundRegisteredTools(executors: {
  send: ToolExecutor
  reply: ToolExecutor
}): readonly RegisteredTool[] {
  return [
    registerOutbound('wechat_send', executors.send),
    registerOutbound('wechat_reply', executors.reply)
  ]
}
