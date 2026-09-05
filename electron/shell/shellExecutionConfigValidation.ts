import type { ShellConfig } from '../../src/shared/domainTypes'

export type ShellExecutionConfigError =
  | 'SHELL_TIMEOUT_CONFIG_INVALID'
  | 'SHELL_OUTPUT_LIMIT_CONFIG_INVALID'
  | 'SHELL_EXECUTABLE_CONFIG_INVALID'
  | 'SHELL_ARGS_CONFIG_INVALID'

export function validateShellExecutionConfig(config?: ShellConfig | null): ShellExecutionConfigError | undefined {
  if (!config) return undefined
  if (!Number.isFinite(config.shellDefaultTimeoutSec) || config.shellDefaultTimeoutSec <= 0) {
    return 'SHELL_TIMEOUT_CONFIG_INVALID'
  }
  if (config.maxInlineOutputBytes != null &&
      (!Number.isFinite(config.maxInlineOutputBytes) || config.maxInlineOutputBytes <= 0)) {
    return 'SHELL_OUTPUT_LIMIT_CONFIG_INVALID'
  }
  if (config.executable != null && config.executable.trim().length === 0) {
    return 'SHELL_EXECUTABLE_CONFIG_INVALID'
  }
  if (config.argsPrefix != null && (!Array.isArray(config.argsPrefix) || config.argsPrefix.some((arg) => typeof arg !== 'string'))) {
    return 'SHELL_ARGS_CONFIG_INVALID'
  }
  return undefined
}
