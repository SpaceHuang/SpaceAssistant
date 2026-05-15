import type { ToolsConfig } from '../src/shared/domainTypes'
import { BUILTIN_TOOL_DEFINITIONS } from '../src/shared/builtinToolDefinitions'

export function isBuiltinToolName(name: string): boolean {
  return BUILTIN_TOOL_DEFINITIONS.some((t) => t.name === name)
}

export function isToolEnabledByConfig(name: string, cfg: ToolsConfig): boolean {
  if (!cfg.enabled) return false
  if (cfg.deniedTools.includes(name)) return false
  if (cfg.allowedTools.length > 0 && !cfg.allowedTools.includes(name)) return false
  return isBuiltinToolName(name)
}

export function filterBuiltinToolsForApi(cfg: ToolsConfig): typeof BUILTIN_TOOL_DEFINITIONS {
  return BUILTIN_TOOL_DEFINITIONS.filter((t) => isToolEnabledByConfig(t.name, cfg))
}
