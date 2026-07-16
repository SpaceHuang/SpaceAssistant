import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { WeChatConfig } from '../src/shared/wechatTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig } from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'
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
  remoteContext?: RemoteContext | null,
  shellConfig?: ShellConfig | null,
  wechat?: WeChatConfig | null
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
  if (!wechat?.enabled) {
    list = list.filter((t) => t.name !== 'wechat_send' && t.name !== 'wechat_reply')
  }
  // wechat_send takes an arbitrary model-chosen userId; remote must only reach the
  // authenticated inbound sender via wechat_reply. This is unconditional — remote never
  // gets wechat_send regardless of remoteDenyOutbound. Desktop keeps wechat_send.
  if (remoteContext) {
    list = list.filter((t) => t.name !== 'wechat_send')
  }
  if (!browserConfig?.enabled) {
    list = list.filter((t) => t.name !== 'browser')
  }
  if (!remoteContext) {
    list = list.filter(
      (t) => t.name !== 'list_work_dirs' && t.name !== 'switch_work_dir' && t.name !== 'switch_session'
    )
  }
  return list
}
