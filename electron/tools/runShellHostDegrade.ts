import { spawnSync } from 'child_process'
import {
  captureShellPathSnapshot,
  prepareShellExecution,
  type PreparedShellExecution
} from '../shell/preparedShellExecution'
import { planShellExec } from '../shell/shellExecPlan'
import { logShellAgentEvent } from '../shell/shellAgentLogger'
import { buildShellArgs } from '../shell/shellProfiles'
import { planHostFallback, shouldAttemptHostDegrade, WINDOWS_HOST_FALLBACK_CHAIN } from '../shell/shellHostFallback'
import type { ShellProfile } from '../shell/shellProfiles'
import type { ToolExecutionContext, ToolExecutorResult } from './types'

export const SHELL_HOST_DEGRADE_DIALECT_INCOMPATIBLE = 'SHELL_HOST_DEGRADE_DIALECT_INCOMPATIBLE'

type RunPrepared = (
  prepared: PreparedShellExecution,
  ctx: ToolExecutionContext,
  started: number,
  baseLog: Record<string, unknown>
) => Promise<ToolExecutorResult>

const WHERE_PROBE_TIMEOUT_MS = 3_000

/** 探测 PATH 上的可执行（PowerShell 是故障方时不能用它探测自身——where.exe 属 cmd 家族工具）。 */
function whereAvailable(executable: string): boolean {
  try {
    const probe = spawnSync('where', [executable], { timeout: WHERE_PROBE_TIMEOUT_MS, windowsHide: true })
    return probe.status === 0
  } catch {
    return false
  }
}

/**
 * 生产环境宿主可用性探测：powershell/cmd 视为恒可用（系统组件，保底语义），
 * pwsh 按注册情况探测。测试经 deps.availability 注入，不走本函数。
 */
export function probeWindowsHostAvailability(): Record<string, boolean> {
  const availability: Record<string, boolean> = {}
  for (const profile of WINDOWS_HOST_FALLBACK_CHAIN) {
    availability[profile.id] =
      profile.id === 'builtin-windows-pwsh' ? whereAvailable(profile.executable) : true
  }
  return availability
}

function buildDegradedPrepared(prepared: PreparedShellExecution, profile: ShellProfile): Promise<PreparedShellExecution> {
  const execPlan = planShellExec(prepared.command, prepared.cwd, {
    executable: profile.executable,
    args: buildShellArgs(profile, ''),
    shellId: profile.id
  })
  return captureShellPathSnapshot([profile.executable, prepared.cwd]).then((pathSnapshot) =>
    prepareShellExecution({
      command: prepared.command,
      profile: {
        id: profile.id,
        dialect: profile.dialect,
        executable: profile.executable,
        outputEncoding: profile.outputEncoding
      },
      spawnSpec: { executable: profile.executable, args: execPlan.spawnArgs, shellId: profile.id },
      cwd: prepared.cwd,
      timeoutMs: prepared.timeoutMs,
      ioMaxBytes: prepared.ioMaxBytes,
      environment: { ...prepared.environment },
      facts: prepared.facts,
      configRevision: prepared.configRevision,
      policyRevision: prepared.policyRevision,
      dependencySnapshot: {
        ...prepared.dependencySnapshot,
        profileId: profile.id,
        executable: profile.executable
      },
      pathSnapshot,
      shellOutputMode: prepared.shellOutputMode,
      spawnStdio: prepared.spawnStdio
    })
  )
}

/** 评审观察项 1/2：仅在真实发生过降级的结果上补 degradedFrom；data.shell 由内层执行已按实际宿主写入。 */
function annotateResult(result: ToolExecutorResult, originalShellId: string): ToolExecutorResult {
  const data = (result.data ?? {}) as Record<string, unknown>
  return {
    ...result,
    data: { ...data, degradedFrom: data.degradedFrom ?? originalShellId }
  }
}

/**
 * P0-C 宿主级降级编排：主宿主初始化失败后，按 powershell → pwsh → cmd 链序尝试
 * 可用且方言兼容的候选宿主（§5.3）。
 *
 * - 每个候选在**新 profile 上重跑方言预检**（约束 1），不兼容则跳过；全部不兼容返回
 *   SHELL_HOST_DEGRADE_DIALECT_INCOMPATIBLE 结构化错误，绝不硬跑（§9）。
 * - 参数模板由 planShellExec 按候选 profile 重新生成（约束 2）。
 * - 实际发生过降级的结果标注 degradedFrom（原始宿主）；实际 shell 由内层执行写入（约束 3）；
 *   无候选可降级时原样返回主宿主失败结果，不制造"已降级"假象。
 * - runPrepared 注入 executePreparedShellExecution；测试注入脚本化实现。
 */
export async function runShellWithHostFallback(deps: {
  prepared: PreparedShellExecution
  ctx: ToolExecutionContext
  started: number
  baseLog: Record<string, unknown>
  primaryResult: ToolExecutorResult
  runPrepared: RunPrepared
  /** 测试注入；缺省用 where.exe 探测 pwsh。 */
  availability?: Record<string, boolean>
  platform?: NodeJS.Platform
}): Promise<ToolExecutorResult> {
  const platform = deps.platform ?? process.platform
  let current = deps.primaryResult
  if (platform !== 'win32' || !shouldAttemptHostDegrade(current)) return current
  const availability = deps.availability ?? probeWindowsHostAvailability()
  const originalShellId = deps.prepared.spawnSpec.shellId
  const excludedShellIds = new Set<string>([originalShellId])
  let currentShellId = originalShellId
  for (;;) {
    const decision = planHostFallback({ currentShellId, excludedShellIds: [...excludedShellIds], availability, command: deps.prepared.command })
    if (decision.kind === 'no-candidates') {
      // 评审观察项 1：未实际降级（无候选）时原样返回，不标 degradedFrom
      return current
    }
    if (decision.kind === 'exhausted') {
      return {
        success: false,
        error: SHELL_HOST_DEGRADE_DIALECT_INCOMPATIBLE,
        userMessage:
          '宿主初始化失败后已尝试降级，但命令方言与全部可用降级宿主不兼容，命令未执行。请用与降级宿主兼容的语法改写命令，或稍后重试。',
        data: {
          code: SHELL_HOST_DEGRADE_DIALECT_INCOMPATIBLE,
          processResult: null,
          status: 'failed',
          degradedFrom: originalShellId,
          incompatible: decision.incompatible,
          hostInitExitCode: (current.data as { exitCode?: number } | undefined)?.exitCode
        },
        duration: Date.now() - deps.started
      }
    }
    const profile = decision.profile
    const degradedPrepared = await buildDegradedPrepared(deps.prepared, profile)
    logShellAgentEvent('warn', 'shell.exec.degrade', {
      ...deps.baseLog,
      shell: profile.id,
      degradedFrom: currentShellId,
      exitCode: (current.data as { exitCode?: number } | undefined)?.exitCode
    })
    const result = await deps.runPrepared(degradedPrepared, deps.ctx, deps.started, deps.baseLog)
    current = annotateResult(result, originalShellId)
    if (!shouldAttemptHostDegrade(current)) return current
    excludedShellIds.add(profile.id)
    currentShellId = profile.id
  }
}
