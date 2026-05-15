import type { ToolsConfig } from './domainTypes'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

export function filterBuiltinToolsForRenderer(cfg: ToolsConfig): typeof BUILTIN_TOOL_DEFINITIONS {
  if (!cfg.enabled) return []
  return BUILTIN_TOOL_DEFINITIONS.filter((t) => {
    if (cfg.deniedTools.includes(t.name)) return false
    if (cfg.allowedTools.length > 0 && !cfg.allowedTools.includes(t.name)) return false
    return true
  })
}
