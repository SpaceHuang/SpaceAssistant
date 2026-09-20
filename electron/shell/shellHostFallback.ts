import { detectShellDialectMismatch } from './shellDialectMismatch'
import {
  WINDOWS_CMD_PROFILE,
  WINDOWS_POWERSHELL_PROFILE,
  WINDOWS_PWSH_PROFILE,
  type ShellProfile
} from './shellProfiles'

/**
 * P0-C 宿主级降级链（计划 §5.3）：
 *
 * Windows 上唯一的 shell 通道曾锁死在 powershell.exe 单点上——宿主初始化失败即整体报废。
 * 本模块只做**纯决策**：降级触发条件、宿主选择顺序、方言预检重跑；执行编排见
 * electron/tools/runShellHostDegrade.ts。
 *
 * 降级触发条件（仅这些，不做通用重试）：
 * - exitCode === 0xFFFF0000（WINDOWS_HOST_INIT_FAILED）
 * - exitCode === 0xC0000142（STATUS_DLL_INIT_FAILED）
 * 不包含：普通非零退出、超时、输出超限、方言错配（各有既有处理路径）。
 */

/** 宿主初始化类失败码：进程创建成功、宿主自身初始化失败后自退。 */
export const HOST_INIT_EXIT_CODES: readonly number[] = [0xffff0000, 0xc0000142]

/** 宿主选择顺序（§5.3）：powershell → pwsh → cmd。 */
export const WINDOWS_HOST_FALLBACK_CHAIN: readonly ShellProfile[] = [
  WINDOWS_POWERSHELL_PROFILE,
  WINDOWS_PWSH_PROFILE,
  WINDOWS_CMD_PROFILE
]

export function isHostInitFailureCode(exitCode: unknown): boolean {
  return typeof exitCode === 'number' && HOST_INIT_EXIT_CODES.includes(exitCode)
}

/** 结构化匹配 executePreparedShellExecution 的宿主初始化失败结果（不依赖具体类型，便于复用）。 */
export function shouldAttemptHostDegrade(result: { success?: boolean; error?: string; data?: unknown }): boolean {
  if (result.success) return false
  if (result.error !== 'SHELL_PROCESS_EXIT') return false
  const data = result.data as
    | { exitCode?: unknown; status?: unknown; timedOut?: unknown; interrupted?: unknown }
    | undefined
  if (!data) return false
  if (data.status !== 'failed' || data.timedOut || data.interrupted) return false
  return isHostInitFailureCode(data.exitCode)
}

export interface HostFallbackInput {
  /** 刚刚失败的宿主（不参与候选）。 */
  currentShellId: string
  /** 本次调用中已尝试过的全部宿主（含主宿主与已失败的降级宿主）：同一确定性故障重试无意义。 */
  excludedShellIds?: readonly string[]
  /** 宿主可用性（注入探测结果）；缺省视为不可用。 */
  availability: Record<string, boolean>
  /** 待执行命令：候选宿主必须重跑方言预检（§5.3 约束 1）。 */
  command: string
}

export interface IncompatibleHost {
  id: string
  executable: string
  signals: string[]
}

export type HostFallbackDecision =
  | { kind: 'degrade'; profile: ShellProfile }
  | { kind: 'exhausted'; incompatible: IncompatibleHost[] }
  | { kind: 'no-candidates' }

/**
 * 按链序选出下一个可用且方言兼容的宿主。
 * 方言不兼容的候选**跳过而非硬跑**（§9：用错误方言执行语义不同的命令属安全回退）。
 */
export function planHostFallback(input: HostFallbackInput): HostFallbackDecision {
  const excluded = new Set([input.currentShellId, ...(input.excludedShellIds ?? [])])
  const candidates = WINDOWS_HOST_FALLBACK_CHAIN.filter(
    (profile) => !excluded.has(profile.id) && input.availability[profile.id] !== false
  )
  if (candidates.length === 0) return { kind: 'no-candidates' }
  const incompatible: IncompatibleHost[] = []
  for (const profile of candidates) {
    const mismatch = detectShellDialectMismatch(input.command, profile)
    if (!mismatch) return { kind: 'degrade', profile }
    incompatible.push({ id: profile.id, executable: profile.executable, signals: [...mismatch.signals] })
  }
  return { kind: 'exhausted', incompatible }
}
