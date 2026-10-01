import { definePlannedTool, type RegisteredTool } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeToolExecutionContext, ToolExecutorResult } from './types'
import type { PreparedShellExecution } from '../shell/preparedShellExecution'
import { executePreparedShellExecutionWithHostFallback } from './runShellExecutor'
import { planRunShellExecution, revalidatePreparedShellExecution } from './runShellPlan'

export type RunShellRegisteredExecutionContext = RuntimeToolExecutionContext & {
  /** 计划阶段注入的运行时能力；execute 只消费其中的 IO/生命周期能力。 */
  runtimeContext?: RuntimeToolExecutionContext
}

export class RunShellExecutionUncertainError extends Error {
  constructor(message = 'Shell 命令执行期间被中断，最终副作用状态未知') {
    super(message)
    this.name = 'RunShellExecutionUncertainError'
  }
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
  validate: async (prepared, execution) => {
    const runtime = (execution as RunShellRegisteredExecutionContext).runtimeContext
    if (!runtime) throw new Error('RUN_SHELL_RUNTIME_CONTEXT_REQUIRED')
    await revalidatePreparedShellExecution(prepared, runtime)
  },
  execute: async (prepared, execution) => {
    const runtime = (execution as RunShellRegisteredExecutionContext).runtimeContext
    if (!runtime) throw new Error('RUN_SHELL_RUNTIME_CONTEXT_REQUIRED')
    const executionRuntime = {
      ...runtime,
      requestId: execution.requestId,
      toolUseId: execution.toolUseId,
      signal: execution.signal
    }
    const result = await executePreparedShellExecutionWithHostFallback(prepared, executionRuntime, Date.now(), {
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
    if (execution.signal.aborted && result.data && typeof result.data === 'object' &&
      'terminationReason' in result.data && result.data.terminationReason === 'user_cancel') {
      throw new RunShellExecutionUncertainError()
    }
    const resultData = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? result.data as Record<string, unknown>
      : undefined
    const timedOut = result.error === 'SHELL_TIMEOUT' || resultData?.terminationReason === 'timeout'
    if (timedOut || result.error === 'OUTPUT_LIMIT_REACHED') {
      if (timedOut) {
        const timeoutSec = typeof resultData?.timeoutSec === 'number' ? resultData.timeoutSec : prepared.timeoutMs / 1000
        const terminationStatus = resultData?.treeKillVerified === true
          ? '受管理进程树已确认终止'
          : resultData?.terminationErrorCode === 'TERMINATION_UNCONFIRMED'
            ? '无法确认受管理进程树是否全部终止'
            : '执行器已尝试终止受管理进程树'
        throw new RunShellExecutionUncertainError(
          `Shell 命令运行至 ${timeoutSec} 秒超时；${terminationStatus}。命令已启动，可能已有部分副作用，完成状态未知。不要盲目重跑。先检查进程、目标文件、输出或 checkpoint；若任务支持恢复，优先使用恢复方式。若确认仍需执行，下一次调用前设置更长的 timeout（1～86400 秒）。nohup 或后台化不能延长受管理进程的执行时间。`
        )
      }
      throw new RunShellExecutionUncertainError()
    }
    if (result.data && typeof result.data === 'object' &&
      'terminationErrorCode' in result.data && result.data.terminationErrorCode === 'TERMINATION_UNCONFIRMED') {
      throw new RunShellExecutionUncertainError()
    }
    return result
  },
  facts: (prepared) => prepared.facts,
  display: (prepared) => ({ command: prepared.command, cwd: prepared.cwd, shell: prepared.spawnSpec.shellId })
})
