import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'
import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import { matchWorkDirProfile } from '../workDirBinding'

type PreparedWorkDirSwitch = Readonly<{
  input: Record<string, unknown>
  selection: Readonly<{
    error?: string
    matches: readonly Readonly<Pick<WorkDirProfile, 'id' | 'name' | 'path' | 'sensitive' | 'aliases'>>[]
  }>
}>

function runtimeContext(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('WORKDIR_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function currentSelection(input: Record<string, unknown>, runtime: RuntimeExecutionContext): PreparedWorkDirSwitch['selection'] {
  const manager = runtime.workDirManager
  if (!manager) return { error: 'workdir-manager-missing', matches: [] }
  const result = matchWorkDirProfile({
    profile_id: typeof input.profile_id === 'string' ? input.profile_id : undefined,
    name: typeof input.name === 'string' ? input.name : undefined,
    alias: typeof input.alias === 'string' ? input.alias : undefined
  }, manager.listProfiles())
  return {
    ...(result.error ? { error: result.error } : {}),
    matches: result.matches.map(({ id, name, path, sensitive, aliases }) => ({
      id, name, path, sensitive: Boolean(sensitive), aliases: [...(aliases ?? [])]
    }))
  }
}

function registerSwitchWorkDir(executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedWorkDirSwitch, ToolExecutorResult>({
    name: 'switch_work_dir',
    actionClass: 'read',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('SWITCH_WORKDIR_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      if (!planning.executionContext) throw new Error('WORKDIR_RUNTIME_CONTEXT_REQUIRED')
      return { input: structuredClone(input), selection: currentSelection(input, planning.executionContext) }
    },
    validate: (prepared, execution) => {
      const selection = currentSelection(prepared.input, runtimeContext(execution))
      if (JSON.stringify(selection) !== JSON.stringify(prepared.selection)) {
        throw new Error('WORKDIR_PREPARED_TARGET_CHANGED')
      }
    },
    execute: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      const selected = prepared.selection.matches.length === 1 ? prepared.selection.matches[0] : undefined
      const input = selected ? { ...prepared.input, profile_id: selected.id } : prepared.input
      return executor.execute(input, {
        ...runtime,
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      })
    },
    facts: ({ selection }) => ({ selection }),
    display: ({ selection }) => ({
      targetProfiles: selection.matches.map(({ id, name, sensitive }) => ({ id, name, sensitive }))
    })
  })
}

/** Bind a remote work-directory switch to the profile set seen during planning. */
export function createSwitchWorkDirRegisteredTool(executor: ToolExecutor): RegisteredTool {
  return registerSwitchWorkDir(executor)
}
