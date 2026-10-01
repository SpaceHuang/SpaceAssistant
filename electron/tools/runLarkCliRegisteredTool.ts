import { createHash } from 'node:crypto'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import { assertSafeLarkCliArgs } from '../feishu/larkCliSecurity'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import type { RemoteContext, ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'

type FeishuAuthorizationBinding = Readonly<{
  cliPath?: string
  useBundledCli?: boolean
  larkCliDefaultTimeoutSec?: number
  larkCliWriteRequiresConfirm?: boolean
  remoteEnabled?: boolean
  remoteDenyOutbound?: boolean
  userAuthorized?: boolean
}>

type RemoteCallerBinding = Readonly<Record<string, unknown>>
type LarkBinding = Readonly<{
  executable?: string
  feishu?: FeishuAuthorizationBinding
  remote?: RemoteCallerBinding
  sessionId: string
  lane?: string
}>
type PreparedLarkCli = Readonly<{
  input: Record<string, unknown>
  normalizedArgs?: readonly string[]
  timeoutSec?: number
  binding: LarkBinding
}>

const REMOTE_KEYS = ['source', 'messageId', 'chatId', 'userId', 'authOwner', 'authorizationGeneration', 'workDirProfileId', 'requestId', 'originSessionId'] as const

function runtimeContext(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('LARK_CLI_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function feishuBinding(config: FeishuConfig | undefined): FeishuAuthorizationBinding | undefined {
  if (!config) return undefined
  return {
    ...(config.cliPath !== undefined ? { cliPath: config.cliPath } : {}),
    ...(config.useBundledCli !== undefined ? { useBundledCli: config.useBundledCli } : {}),
    ...(config.larkCliDefaultTimeoutSec !== undefined ? { larkCliDefaultTimeoutSec: config.larkCliDefaultTimeoutSec } : {}),
    ...(config.larkCliWriteRequiresConfirm !== undefined ? { larkCliWriteRequiresConfirm: config.larkCliWriteRequiresConfirm } : {}),
    ...(config.remoteEnabled !== undefined ? { remoteEnabled: config.remoteEnabled } : {}),
    ...(config.remoteDenyOutbound !== undefined ? { remoteDenyOutbound: config.remoteDenyOutbound } : {}),
    ...(config.userAuthorized !== undefined ? { userAuthorized: config.userAuthorized } : {})
  }
}

function callerBinding(remote: RemoteContext | undefined): RemoteCallerBinding | undefined {
  if (!remote) return undefined
  return Object.fromEntries(REMOTE_KEYS.flatMap((key) => remote[key] === undefined ? [] : [[key, remote[key]]]))
}

function currentBinding(runtime: RuntimeExecutionContext): LarkBinding {
  const runner = runtime.larkCliRunner as LarkCliRunner | undefined
  return {
    ...(runner && typeof runner.resolveExecutable === 'function' ? { executable: runner.resolveExecutable() } : {}),
    ...(feishuBinding(runtime.feishuConfig) ? { feishu: feishuBinding(runtime.feishuConfig)! } : {}),
    ...(callerBinding(runtime.remoteContext) ? { remote: callerBinding(runtime.remoteContext)! } : {}),
    sessionId: runtime.sessionId,
    ...(runtime.lane !== undefined ? { lane: runtime.lane } : {})
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Freeze safe argv, effective timeout, CLI executable and Feishu authorization context pre-dispatch. */
export function createRunLarkCliRegisteredTool(executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedLarkCli, ToolExecutorResult>({
    name: 'run_lark_cli',
    actionClass: 'execute',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('LARK_CLI_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error('LARK_CLI_RUNTIME_CONTEXT_REQUIRED')
      const runtime = planning.executionContext
      const binding = currentBinding(runtime)
      let normalizedArgs: string[] | undefined
      try {
        normalizedArgs = assertSafeLarkCliArgs(input.args)
      } catch {
        // Let the legacy executor produce its established validation result.
      }
      const timeoutSec = normalizedArgs
        ? (typeof input.timeout === 'number' && input.timeout > 0
          ? input.timeout
          : runtime.feishuConfig?.larkCliDefaultTimeoutSec ?? 120)
        : undefined
      return {
        input: structuredClone(normalizedArgs && timeoutSec !== undefined
          ? { ...input, args: normalizedArgs, timeout: timeoutSec }
          : input),
        ...(normalizedArgs ? { normalizedArgs: [...normalizedArgs] } : {}),
        ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        binding
      }
    },
    validate: (prepared, execution) => {
      if (hash(currentBinding(runtimeContext(execution))) !== hash(prepared.binding)) {
        throw new Error('LARK_CLI_PREPARED_AUTHORIZATION_CHANGED')
      }
    },
    execute: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      return executor.execute(prepared.input, {
        ...runtime,
        ...(prepared.binding.executable ? { preparedLarkCliExecutable: prepared.binding.executable } : {}),
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      })
    },
    facts: (prepared) => ({
      inputHash: hash(prepared.input),
      argvHash: prepared.normalizedArgs ? hash(prepared.normalizedArgs) : undefined,
      timeoutSec: prepared.timeoutSec,
      authorizationBindingHash: hash(prepared.binding)
    }),
    display: (prepared) => ({
      subcommand: prepared.normalizedArgs?.[0] ?? 'invalid',
      argumentCount: prepared.normalizedArgs?.length ?? 0
    })
  })
}
