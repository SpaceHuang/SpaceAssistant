import type { FeishuConfig } from './feishuTypes'
import type { BrowserConfig, ToolsConfig } from './domainTypes'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

export function filterBuiltinToolsForRenderer(
  cfg: ToolsConfig,
  feishu?: FeishuConfig | null,
  browserConfig?: BrowserConfig | null
): typeof BUILTIN_TOOL_DEFINITIONS {
  if (!cfg.enabled) return []
  let list = BUILTIN_TOOL_DEFINITIONS.filter((t) => {
    if (cfg.deniedTools.includes(t.name)) return false
    if (cfg.allowedTools.length > 0 && !cfg.allowedTools.includes(t.name)) return false
    return true
  })
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
