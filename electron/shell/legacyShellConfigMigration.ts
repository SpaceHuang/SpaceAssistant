import path from 'path'
import type { ShellConfig } from '../../src/shared/domainTypes'
import { WINDOWS_POWERSHELL_PROFILE } from './shellProfiles'

export type LegacyShellMigrationResult =
  | { status: 'unchanged'; config: ShellConfig }
  | { status: 'migrated'; config: ShellConfig; profileId: string }
  | { status: 'unsupported'; config: ShellConfig; reason: 'custom-executable' | 'cmd-profile' | 'custom-args' }

/**
 * 将旧的 executable/argsPrefix 配置转换为显式 profile 边界。
 * 这是纯迁移函数，不负责写 DB；调用方必须向用户展示 unsupported 结果并要求重新选择 profile。
 */
export function migrateLegacyShellConfig(config: ShellConfig, platform: NodeJS.Platform): LegacyShellMigrationResult {
  if (!config.executable && !config.argsPrefix?.length) return { status: 'unchanged', config: { ...config } }

  const executable = config.executable?.trim() ?? ''
  const basename = path.win32.basename(executable.replace(/\\/g, '/')).toLowerCase()
  if (basename === 'cmd.exe' || basename === 'cmd') {
    return { status: 'unsupported', config: { ...config }, reason: 'cmd-profile' }
  }

  if (platform === 'win32' && (basename === 'powershell.exe' || basename === 'powershell')) {
    return {
      status: 'migrated',
      profileId: WINDOWS_POWERSHELL_PROFILE.id,
      config: { ...config, executable: WINDOWS_POWERSHELL_PROFILE.executable, argsPrefix: undefined }
    }
  }

  if (config.argsPrefix?.length) {
    return { status: 'unsupported', config: { ...config }, reason: 'custom-args' }
  }
  return { status: 'unsupported', config: { ...config }, reason: 'custom-executable' }
}
