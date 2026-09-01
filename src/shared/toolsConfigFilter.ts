import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

/**
 * 渲染端薄壳：只消费主进程评估下发的可见工具清单（exposure 规则、deniedTools、
 * 各开关均已在主进程生效），不再维护镜像 if 链（§5.2 exposure 定稿）。
 */
export function filterBuiltinToolsForRenderer(
  visibleTools: readonly string[]
): typeof BUILTIN_TOOL_DEFINITIONS {
  const visible = new Set(visibleTools)
  return BUILTIN_TOOL_DEFINITIONS.filter((t) => visible.has(t.name))
}
