import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeExecutionContext, ToolExecutor, ToolExecutorResult } from './types'
import { buildScriptExecutionEnv, stableScriptMaterialDigest, stableScriptMaterialSerialize } from '../processOutputEncoding'
import { hasStaticNetworkReviewCandidate } from '../confirmation/extractors/scriptAnalysisExtractor'

type ScriptSettings = Readonly<{
  workDir: string
  userDataDir: string
  scriptTimeout: number
  pythonPath?: string
  scriptInterpreterPaths?: RuntimeExecutionContext['toolsConfig']['scriptInterpreterPaths']
}>
type PreparedScript = Readonly<{
  input: Record<string, unknown>
  settings: ScriptSettings
  environment?: NodeJS.ProcessEnv
  environmentDigest?: string
  networkReviewCandidate: boolean
}>

export class RunScriptExecutionUncertainError extends Error {
  constructor() {
    super('脚本执行期间被中断，最终副作用状态未知')
    this.name = 'RunScriptExecutionUncertainError'
  }
}

function runtimeContext(context: ToolExecutionContext): RuntimeExecutionContext {
  const runtime = context.runtimeContext as RuntimeExecutionContext | undefined
  if (!runtime) throw new Error('RUN_SCRIPT_RUNTIME_CONTEXT_REQUIRED')
  return runtime
}

function scriptSettings(runtime: RuntimeExecutionContext): ScriptSettings {
  return structuredClone({
    workDir: runtime.workDir,
    userDataDir: runtime.userDataDir,
    scriptTimeout: runtime.toolsConfig.scriptTimeout,
    ...(runtime.toolsConfig.pythonPath !== undefined ? { pythonPath: runtime.toolsConfig.pythonPath } : {}),
    ...(runtime.toolsConfig.scriptInterpreterPaths ? { scriptInterpreterPaths: runtime.toolsConfig.scriptInterpreterPaths } : {})
  })
}

function hash(value: unknown): string {
  return stableScriptMaterialDigest(value)
}

function scriptEnvironment(runtime: RuntimeExecutionContext, candidate: boolean): NodeJS.ProcessEnv {
  return buildScriptExecutionEnv(process.env, runtime.lane, candidate)
}

/** Freeze code and interpreter inputs before the permit-bound dispatch claim. */
export function createRunScriptRegisteredTool(executor: ToolExecutor): RegisteredTool {
  return definePlannedTool<Record<string, unknown>, PreparedScript, ToolExecutorResult>({
    name: 'run_script',
    actionClass: 'execute',
    parseInput: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('RUN_SCRIPT_INPUT_INVALID')
      return structuredClone(raw as Record<string, unknown>)
    },
    plan: async (input, planning) => {
      const runtime = planning.executionContext as RuntimeExecutionContext | undefined
      if (!runtime) throw new Error('RUN_SCRIPT_RUNTIME_CONTEXT_REQUIRED')
      const networkReviewCandidate = input.language === 'python' && typeof input.code === 'string' && hasStaticNetworkReviewCandidate(input.code)
      const environment = networkReviewCandidate ? scriptEnvironment(runtime, true) : undefined
      const environmentDigest = environment ? stableScriptMaterialDigest(environment) : undefined
      return { input: structuredClone(input), settings: scriptSettings(runtime), ...(environment ? { environment } : {}), environmentDigest, networkReviewCandidate }
    },
    validate: (prepared, execution) => {
      if (stableScriptMaterialSerialize(scriptSettings(runtimeContext(execution))) !== stableScriptMaterialSerialize(prepared.settings)) {
        throw new Error('RUN_SCRIPT_PREPARED_SETTINGS_CHANGED')
      }
      const currentRuntime = runtimeContext(execution)
      if (prepared.networkReviewCandidate !== (currentRuntime.expectedScriptNetworkReviewCandidate === true)) {
        throw new Error('RUN_SCRIPT_GATE_CANDIDATE_BINDING_CHANGED')
      }
      if (prepared.networkReviewCandidate) {
        if ((currentRuntime.lane === 'wechat' || currentRuntime.lane === 'feishu') && !currentRuntime.expectedScriptSettingsDigest) {
          throw new Error('RUN_SCRIPT_EXPECTED_SETTINGS_BINDING_MISSING')
        }
        if (currentRuntime.expectedScriptSettingsDigest && currentRuntime.expectedScriptSettingsDigest !== hash(prepared.settings)) {
          throw new Error('RUN_SCRIPT_GATE_SETTINGS_MISMATCH')
        }
        if (!prepared.environment || !prepared.environmentDigest || !currentRuntime.expectedScriptEnvironmentDigest) {
          throw new Error('RUN_SCRIPT_EXPECTED_ENVIRONMENT_BINDING_MISSING')
        }
        if (stableScriptMaterialDigest(scriptEnvironment(currentRuntime, true)) !== prepared.environmentDigest) {
          throw new Error('RUN_SCRIPT_PREPARED_ENVIRONMENT_CHANGED')
        }
        if (currentRuntime.expectedScriptEnvironmentDigest !== prepared.environmentDigest) {
          throw new Error('RUN_SCRIPT_GATE_ENVIRONMENT_MISMATCH')
        }
      }
    },
    execute: async (prepared, execution) => {
      const runtime = runtimeContext(execution)
      const toolsConfig = {
        ...runtime.toolsConfig,
        scriptTimeout: prepared.settings.scriptTimeout,
        ...(prepared.settings.pythonPath !== undefined ? { pythonPath: prepared.settings.pythonPath } : {}),
        ...(prepared.settings.scriptInterpreterPaths ? { scriptInterpreterPaths: prepared.settings.scriptInterpreterPaths } : {})
      }
      const result = await executor.execute(prepared.input, {
        ...runtime,
        workDir: prepared.settings.workDir,
        userDataDir: prepared.settings.userDataDir,
        toolsConfig,
        ...(prepared.environment ? { scriptEnvironment: structuredClone(prepared.environment) } : {}),
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      })
      if (execution.signal.aborted && result.error === 'SCRIPT_CANCELLED') {
        throw new RunScriptExecutionUncertainError()
      }
      if (result.error === 'SCRIPT_TIMEOUT') {
        throw new RunScriptExecutionUncertainError()
      }
      return result
    },
    facts: (prepared) => ({
      inputDigest: hash(prepared.input),
      language: prepared.input.language,
      codeDigest: hash(typeof prepared.input.code === 'string' ? prepared.input.code : ''),
      settingsDigest: hash(prepared.settings),
      ...(prepared.environmentDigest ? { environmentDigest: prepared.environmentDigest } : {})
    }),
    display: (prepared) => ({
      language: prepared.input.language,
      codeLength: typeof prepared.input.code === 'string' ? prepared.input.code.length : 0,
      codeDigest: hash(typeof prepared.input.code === 'string' ? prepared.input.code : '').slice(0, 16),
      workDir: prepared.settings.workDir
    })
  })
}
