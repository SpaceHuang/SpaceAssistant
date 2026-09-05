import { definePlannedTool, type RegisteredTool } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeToolExecutionContext, ToolExecutorResult } from './types'
import type { PreparedShellExecution } from '../shell/preparedShellExecution'
import { executePreparedShellExecution } from './runShellExecutor'
import { planRunShellExecution } from './runShellPlan'

export type RunShellRegisteredExecutionContext = RuntimeToolExecutionContext & {
  /** 计划阶段注入的运行时能力；execute 只消费其中的 IO/生命周期能力。 */
  runtimeContext?: RuntimeToolExecutionContext
}

/**
 * run_shell 的正式 planned registration。
 * 计划和执行之间只传递 PreparedShellExecution，不允许 execute 重新解析原始输入。
 */
export const runShellRegisteredTool: RegisteredTool = definePlannedTool<
  Record<string, unknown>,
  PreparedShellExecution,
  ToolExecutorResult
>({
  name: 'run_shell',
  parseInput: (raw) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}),
  plan: async (input, planning) => {
    const runtime = planning.executionContext
    if (!runtime) throw new Error('RUN_SHELL_RUNTIME_CONTEXT_REQUIRED')
    return planRunShellExecution(input, runtime)
  },
  execute: async (prepared, execution) => {
    const runtime = (execution as RunShellRegisteredExecutionContext).runtimeContext
    if (!runtime) throw new Error('RUN_SHELL_RUNTIME_CONTEXT_REQUIRED')
    return executePreparedShellExecution(prepared, runtime, Date.now(), {
      requestId: runtime.requestId,
      sessionId: runtime.sessionId,
      toolUseId: runtime.toolUseId,
      command: prepared.command,
      cwd: prepared.cwd,
      shell: prepared.spawnSpec.shellId,
      timeoutSec: prepared.timeoutMs / 1000,
      ioMaxBytes: prepared.ioMaxBytes,
      environmentFingerprint: prepared.dependencySnapshot.environmentFingerprint,
      planDigest: prepared.planDigest
    })
  },
  facts: (prepared) => prepared.facts,
  display: (prepared) => ({ command: prepared.command, cwd: prepared.cwd, shell: prepared.spawnSpec.shellId })
})
