import type { FeishuConfig } from './feishuTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig } from './domainTypes'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

export function filterBuiltinToolsForRenderer(
  cfg: ToolsConfig,
  feishu?: FeishuConfig | null,
  browserConfig?: BrowserConfig | null,
  shellConfig?: ShellConfig | null,
  /** 主进程预计算的可见工具清单（exposure 规则 + deniedTools）；提供时不重新过滤，仅作薄壳映射。 */
  visibleTools?: string[]
): typeof BUILTIN_TOOL_DEFINITIONS {
  if (!cfg.enabled) return []
  if (visibleTools) {
    // 渲染端薄壳：直接消费主进程评估结果（deniedTools/exposure 规则已在主进程生效）
    return BUILTIN_TOOL_DEFINITIONS.filter((t) => visibleTools.includes(t.name))
  }
  let list = BUILTIN_TOOL_DEFINITIONS.filter((t) => {
    if (cfg.deniedTools.includes(t.name)) return false
    if (cfg.allowedTools.length > 0 && !cfg.allowedTools.includes(t.name)) return false
    return true
  })
  if (!shellConfig?.enabled) {
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
