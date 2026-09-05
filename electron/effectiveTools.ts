import type { PolicyRule } from '../src/shared/confirmation/types'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { snapshotEntriesToAnthropicTools, type McpToolSnapshot } from './mcp/mcpToolRegistry'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../src/shared/domainTypes'
import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { WeChatConfig } from '../src/shared/wechatTypes'
import type { RemoteContext } from './tools/types'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from './anthropicToolPayload'

export type EffectiveTools = {
  tools: unknown[]
  toolNames: string[]
  authorizedToolNames: ReadonlySet<string>
}

export function computeEffectiveTools(args: {
  builtinConfig: ToolsConfig
  feishuConfig?: FeishuConfig | null
  browserConfig?: BrowserConfig | null
  shellConfig?: ShellConfig | null
  wechatConfig?: WeChatConfig | null
  remoteContext?: RemoteContext | null
  exposureRules?: PolicyRule[]
  mcpSnapshot?: McpToolSnapshot
}): EffectiveTools {
  const builtin = filterBuiltinToolsForApi(
    args.builtinConfig,
    args.feishuConfig,
    args.browserConfig,
    args.remoteContext,
    args.shellConfig,
    args.wechatConfig,
    undefined,
    args.exposureRules
  )
  const mcp = args.remoteContext ? [] : snapshotEntriesToAnthropicTools(args.mcpSnapshot?.entries.values() ?? [])
  const tools = sanitizeAnthropicToolsPayloadForStrictGateways([...builtin, ...mcp] as unknown[])
  const toolNames = tools.flatMap((tool) => {
    const name = (tool as { name?: unknown }).name
    return typeof name === 'string' ? [name] : []
  })
  return { tools, toolNames, authorizedToolNames: new Set(toolNames) }
}

export function authorizeToolCall(toolName: string, authorizedToolNames: ReadonlySet<string>):
  | { ok: true }
  | { ok: false; error: 'tool_not_authorized' } {
  return authorizedToolNames.has(toolName) ? { ok: true } : { ok: false, error: 'tool_not_authorized' }
}
