import type { AppDatabase } from '../database'
import { getConfigValue, setConfigValue } from '../database'
import { mergeShellConfig, type ShellConfig } from '../../src/shared/domainTypes'

export const SHELL_CONFIG_KEY = 'config.shell'

export function readShellConfigFromDb(db: AppDatabase): ShellConfig {
  const raw = getConfigValue(db, SHELL_CONFIG_KEY)
  if (!raw) return mergeShellConfig(null)
  try {
    return mergeShellConfig(JSON.parse(raw) as Partial<ShellConfig>)
  } catch {
    return mergeShellConfig(null)
  }
}

export function persistShellConfig(db: AppDatabase, partial: Partial<ShellConfig>): ShellConfig {
  const next = mergeShellConfig({ ...readShellConfigFromDb(db), ...partial })
  setConfigValue(db, SHELL_CONFIG_KEY, JSON.stringify(next))
  return next
}

/** shell.enabled=false 时确保 run_shell 在 deniedTools 中 */
export function syncShellDeniedTools(
  shell: ShellConfig,
  deniedTools: string[]
): string[] {
  const set = new Set(deniedTools)
  if (!shell.enabled) {
    set.add('run_shell')
  } else {
    set.delete('run_shell')
  }
  return [...set]
}
