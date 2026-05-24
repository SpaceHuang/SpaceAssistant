import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'
import type { ToolsConfig } from './domainTypes'
import { filterBuiltinToolsForRenderer } from './toolsConfigFilter'

export const PLAN_READONLY_TOOL_NAMES = ['read_file', 'list_directory', 'grep'] as const

export type PlanToolPhase = 'planning' | 'implementation'

export function isPlanReadonlyToolName(name: string): boolean {
  return (PLAN_READONLY_TOOL_NAMES as readonly string[]).includes(name)
}

/** Plan exploration phase: only expose read-only builtin tools to the API. */
export function filterBuiltinToolsForPlanPhase(
  cfg: ToolsConfig,
  phase: PlanToolPhase
): typeof BUILTIN_TOOL_DEFINITIONS {
  const enabled = filterBuiltinToolsForRenderer(cfg)
  if (phase === 'implementation') return enabled
  return enabled.filter((t) => isPlanReadonlyToolName(t.name))
}
