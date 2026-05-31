import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig } from '../src/shared/domainTypes'
import type { FeishuRemoteContext } from './tools/types'
import { BUILTIN_TOOL_DEFINITIONS } from '../src/shared/builtinToolDefinitions'

export function isShellToolEnabled(shellConfig: ShellConfig | null | undefined, cfg: ToolsConfig): boolean {
  if (!shellConfig?.enabled) return false
  return isToolEnabledByConfig('run_shell', cfg)
}

export function isBuiltinToolName(name: string): boolean {
  return BUILTIN_TOOL_DEFINITIONS.some((t) => t.name === name)
}

export function isToolEnabledByConfig(name: string, cfg: ToolsConfig): boolean {
  if (!cfg.enabled) return false
  if (cfg.deniedTools.includes(name)) return false
  if (cfg.allowedTools.length > 0 && !cfg.allowedTools.includes(name)) return false
  return isBuiltinToolName(name)
}

export function filterBuiltinToolsForApi(
  cfg: ToolsConfig,
  feishu?: FeishuConfig | null,
  browserConfig?: BrowserConfig | null,
  remoteContext?: FeishuRemoteContext | null,
  shellConfig?: ShellConfig | null
): typeof BUILTIN_TOOL_DEFINITIONS {
  let list = BUILTIN_TOOL_DEFINITIONS.filter((t) => isToolEnabledByConfig(t.name, cfg))
  if (!isShellToolEnabled(shellConfig, cfg)) {
    list = list.filter((t) => t.name !== 'run_shell')
  }
  if (!feishu?.enabled) {
    list = list.filter((t) => t.name !== 'run_lark_cli' && t.name !== 'read_feishu_attachment')
  }
  if (feishu?.integrationMode === 'mcp') {
    list = list.filter((t) => t.name !== 'run_lark_cli')
  }
  if (!browserConfig?.enabled) {
    list = list.filter((t) => t.name !== 'browser')
  }
  return list
}
