import fs from 'fs/promises'
import path from 'path'
import type { ShellConfig } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import { buildShellEnv } from '../processOutputEncoding'
import { applyPlaywrightInstallShellEnv } from '../shell/shellSpawnEnv'
import { planShellExec, type ShellSpawnSpec } from '../shell/shellExecPlan'
import { analyzeShellFacts } from '../shell/shellAnalyzer'
import { assertPreparedShellExecutionCurrent, captureShellPathSnapshot, prepareShellExecution, type PreparedShellExecution } from '../shell/preparedShellExecution'
import { profileForPlatform, buildShellArgs } from '../shell/shellProfiles'
import { resolveShellEnvironment } from '../shell/environmentResolver'
import { validateShellExecutionConfig } from '../shell/shellExecutionConfigValidation'
import { detectShellDialectMismatch } from '../shell/shellDialectMismatch'
import { isInteractiveShellTuiCommand } from '../../src/shared/shellInteractiveTui'
import { migrateLegacyShellConfig } from '../shell/legacyShellConfigMigration'

const DEFAULT_IO_MAX = 100 * 1024

export type RunShellPlanErrorCode =
  | 'SHELL_PLAN_INVALID'
  | 'SHELL_EXECUTABLE_UNAVAILABLE'
  | 'SHELL_INTERACTIVE_TTY_REQUIRED'
  | 'SHELL_DIALECT_MISMATCH'

export class RunShellPlanError extends Error {
  constructor(readonly code: RunShellPlanErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RunShellPlanError'
  }
}

export function normalizeShellConfigForPlatform(shellConfig: ShellConfig | null | undefined, platform: NodeJS.Platform = process.platform): ShellConfig | undefined {
  if (platform !== 'win32' || !shellConfig) return shellConfig ?? undefined
  const migration = migrateLegacyShellConfig(shellConfig, platform)
  return migration.status === 'migrated' ? migration.config : shellConfig
}

function resolveSpec(shellConfig?: ShellConfig | null, platform: NodeJS.Platform = process.platform): ShellSpawnSpec {
  const executable = shellConfig?.executable?.trim()
  if (platform === 'win32' && executable && /(^|[\\/])powershell(?:\.exe)?$/i.test(executable) && !shellConfig?.argsPrefix?.length) {
    const profile = profileForPlatform(platform)
    return { executable: profile.executable, args: buildShellArgs(profile, ''), shellId: profile.id }
  }
  if (executable) {
    const prefix = shellConfig?.argsPrefix?.length ? shellConfig.argsPrefix : ['-lc']
    return { executable, args: [...prefix, ''], shellId: path.basename(executable) }
  }
  const profile = profileForPlatform(platform)
  return { executable: profile.executable, args: buildShellArgs(profile, ''), shellId: profile.id }
}

export function shellConfigRevision(shellConfig?: ShellConfig | null, platform: NodeJS.Platform = process.platform): string {
  const normalizedConfig = normalizeShellConfigForPlatform(shellConfig, platform)
  const timeoutSec = normalizedConfig?.shellDefaultTimeoutSec ?? 300
  const ioMax = normalizedConfig?.maxInlineOutputBytes ?? DEFAULT_IO_MAX
  const spec = resolveSpec(normalizedConfig, platform)
  return JSON.stringify({
    timeoutSec,
    ioMax,
    shell: spec.shellId,
    executable: spec.executable,
    argsPrefix: spec.args.slice(0, -1)
  })
}

function isPathLike(executable: string): boolean {
  return path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')
}

async function assertExecutableAvailable(executable: string): Promise<void> {
  if (!isPathLike(executable)) return
  try {
    await fs.access(executable)
  } catch {
    throw new RunShellPlanError('SHELL_EXECUTABLE_UNAVAILABLE', 'SHELL_EXECUTABLE_UNAVAILABLE', { executable })
  }
}

/** 唯一的 Shell 计划入口：只生成执行事实，不执行进程，也不包含授权结论。 */
export async function planRunShellExecution(
  input: Record<string, unknown>,
  ctx: Pick<ToolExecutionContext, 'workDir' | 'userDataDir' | 'shellConfig' | 'policyRevision'>
): Promise<PreparedShellExecution> {
  let shellConfig = ctx.shellConfig
  if (process.platform === 'win32' && shellConfig) {
    const migration = migrateLegacyShellConfig(shellConfig, process.platform)
    if (migration.status === 'unsupported') {
      throw new RunShellPlanError('SHELL_PLAN_INVALID', 'SHELL_LEGACY_CONFIG_UNSUPPORTED', {
        reason: migration.reason
      })
    }
    shellConfig = migration.config
  }
  const configError = validateShellExecutionConfig(shellConfig)
  if (configError) throw new RunShellPlanError('SHELL_PLAN_INVALID', configError)
  const command = typeof input.command === 'string' ? input.command : ''
  const timeoutSec = typeof input.timeout === 'number' ? input.timeout : shellConfig?.shellDefaultTimeoutSec ?? 300
  const spec = resolveSpec(shellConfig)
  await assertExecutableAvailable(spec.executable)
  const profile = profileForPlatform(process.platform)
  if (isInteractiveShellTuiCommand(command)) {
    throw new RunShellPlanError('SHELL_INTERACTIVE_TTY_REQUIRED', 'SHELL_INTERACTIVE_TTY_REQUIRED')
  }
  const mismatch = detectShellDialectMismatch(command, profile)
  if (mismatch) throw new RunShellPlanError('SHELL_DIALECT_MISMATCH', 'SHELL_DIALECT_MISMATCH', { ...mismatch })
  let execPlan: ReturnType<typeof planShellExec>
  try {
    execPlan = planShellExec(command, ctx.workDir, spec)
  } catch (error) {
    throw new RunShellPlanError('SHELL_PLAN_INVALID', error instanceof Error ? error.message : String(error))
  }
  const resolved = resolveShellEnvironment(process.env, [
    'DEBUG', 'PLAYWRIGHT_FORCE_TTY', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'
  ])
  const env = buildShellEnv(resolved.env)
  applyPlaywrightInstallShellEnv(env, command)
  const pathSnapshot = await captureShellPathSnapshot([spec.executable, execPlan.cwd])
  return prepareShellExecution({
    command,
    profile: { ...profile, executable: spec.executable },
    spawnSpec: { executable: spec.executable, args: execPlan.spawnArgs, shellId: spec.shellId },
    cwd: execPlan.cwd,
    timeoutMs: timeoutSec * 1000,
    ioMaxBytes: shellConfig?.maxInlineOutputBytes ?? DEFAULT_IO_MAX,
    environment: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    facts: analyzeShellFacts(command, profile.dialect),
    configRevision: shellConfigRevision(shellConfig),
    policyRevision: ctx.policyRevision ?? 'runtime',
    dependencySnapshot: { platform: process.platform, profileId: profile.id, executable: spec.executable, environmentFingerprint: resolved.fingerprint },
    pathSnapshot
  })
}

/**
 * 在确认等待结束后只重验证运行时依赖，不重新解析用户输入或读取 shellConfig。
 * 配置/命令的决策仍以 plan 阶段的冻结快照为准。
 */
export async function revalidatePreparedShellExecution(
  prepared: PreparedShellExecution,
  current: { shellConfig?: ShellConfig | null; policyRevision?: string } = {}
): Promise<void> {
  const resolved = resolveShellEnvironment(process.env, [
    'DEBUG', 'PLAYWRIGHT_FORCE_TTY', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'
  ])
  const env = buildShellEnv(resolved.env)
  applyPlaywrightInstallShellEnv(env, prepared.command)
  const pathSnapshot = await captureShellPathSnapshot([prepared.spawnSpec.executable, prepared.cwd])
  assertPreparedShellExecutionCurrent(prepared, {
    profile: prepared.profile,
    spawnSpec: prepared.spawnSpec,
    cwd: prepared.cwd,
    timeoutMs: prepared.timeoutMs,
    environment: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    configRevision: shellConfigRevision(current.shellConfig),
    policyRevision: current.policyRevision ?? prepared.policyRevision,
    dependencySnapshot: prepared.dependencySnapshot,
    pathSnapshot
  })
}
