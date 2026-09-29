import { getConfigValue, setConfigValue, type AppDatabase } from './database'
import { mergeShellConfig, mergeToolsConfig, type ToolsConfig } from '../src/shared/domainTypes'
import { SHELL_CONFIG_KEY } from './shell/shellConfigDb'

/**
 * 存量「Shell 命令默认关闭」固化迁移（版本门控、幂等、失败不阻塞）。
 *
 * 背景：`bd5b5a01`（2026-09-11）已把新默认改为开启（`deniedTools: []` +
 * `DEFAULT_SHELL_CONFIG.enabled: true`），但设置页任意一次保存都会把当时的全量
 * 状态序列化进 `config.tools`——旧版本时期保存过设置的用户，其数据库里被旧默认
 * 固化的 `deniedTools: ['run_shell']` 会一直覆盖新默认，设置页「工具开关 → Shell
 * 命令」显示为关闭。
 *
 * 迁移判据（旧默认的精确指纹，保守）：`deniedTools` **恰好**等于 `['run_shell']`。
 * 用户若额外禁用了其他工具，说明动过开关面板（有意配置），保持不动。
 * 迁移同时把 `config.shell.enabled` 置 true（开关数据流的双侧同步）。
 *
 * 已知边界：在旧版本下「有意关闭且未禁其他工具」的用户会被一并打开一次；
 * 该迁移为版本门控一次性，用户此后再关闭不会被二次改动。
 */
export const SHELL_DEFAULT_ENABLE_MIGRATION_VERSION = 1
export const SHELL_DEFAULT_ENABLE_MIGRATION_VERSION_KEY = 'config.shellDefaultEnable.migrationVersion'
const SHELL_DEFAULT_LEGACY_DENIED = ['run_shell']

export type ShellDefaultEnableMigrationResult = { status: 'done' | 'skipped'; migrated: boolean }

function parseToolsConfig(raw: string | null | undefined): { deniedTools?: unknown } | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { deniedTools?: unknown })
      : undefined
  } catch {
    return undefined
  }
}

function isLegacyDefaultFingerprint(deniedTools: unknown): deniedTools is string[] {
  return (
    Array.isArray(deniedTools) &&
    deniedTools.length === SHELL_DEFAULT_LEGACY_DENIED.length &&
    deniedTools.every((x) => typeof x === 'string') &&
    [...deniedTools].sort().join(',') === [...SHELL_DEFAULT_LEGACY_DENIED].sort().join(',')
  )
}

export function runShellDefaultEnableMigrationOnce(db: AppDatabase): ShellDefaultEnableMigrationResult {
  const current = Number(getConfigValue(db, SHELL_DEFAULT_ENABLE_MIGRATION_VERSION_KEY) ?? 0)
  if (current >= SHELL_DEFAULT_ENABLE_MIGRATION_VERSION) {
    return { status: 'skipped', migrated: false }
  }
  setConfigValue(db, SHELL_DEFAULT_ENABLE_MIGRATION_VERSION_KEY, String(SHELL_DEFAULT_ENABLE_MIGRATION_VERSION))
  try {
    const parsed = parseToolsConfig(getConfigValue(db, 'config.tools'))
    if (!parsed || !isLegacyDefaultFingerprint(parsed.deniedTools)) {
      return { status: 'done', migrated: false }
    }
    const nextDenied = (parsed.deniedTools as string[]).filter((x) => x !== 'run_shell')
    const nextTools: Partial<ToolsConfig> = { ...parsed, deniedTools: nextDenied } as Partial<ToolsConfig>
    setConfigValue(db, 'config.tools', JSON.stringify(mergeToolsConfig(nextTools)))
    // 开关数据流双侧同步：config.shell.enabled 与 deniedTools 联动（syncShellDeniedTools 的迁移侧等价物）
    const rawShell = getConfigValue(db, SHELL_CONFIG_KEY)
    let shellPartial: Record<string, unknown> = {}
    if (rawShell) {
      try {
        const parsedShell: unknown = JSON.parse(rawShell)
        if (parsedShell && typeof parsedShell === 'object' && !Array.isArray(parsedShell)) {
          shellPartial = parsedShell as Record<string, unknown>
        }
      } catch {
        /* 损坏 shell 配置：仅写 enabled，保底可开 */
      }
    }
    setConfigValue(db, SHELL_CONFIG_KEY, JSON.stringify(mergeShellConfig({ ...shellPartial, enabled: true })))
    return { status: 'done', migrated: true }
  } catch {
    // fail-safe：不阻塞启动
    return { status: 'done', migrated: false }
  }
}
