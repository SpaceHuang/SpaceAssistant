import type { PolicyRule } from '../src/shared/confirmation/types'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { snapshotEntriesToAnthropicTools, type McpToolSnapshot } from './mcp/mcpToolRegistry'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../src/shared/domainTypes'
import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { WeChatConfig } from '../src/shared/wechatTypes'
import type { RemoteContext } from './tools/types'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from './anthropicToolPayload'
import { toolIdToOpenAiCompatibleApiToolName } from '../src/shared/anthropicToolSanitize'

export type EffectiveTools = {
  tools: unknown[]
  toolNames: string[]
  authorizedToolNames: ReadonlySet<string>
  /** compat 名（API 口径，点号已替换为下划线）→ 内部注册名。分发循环回向解析用（B1）。 */
  compatToInternal: ReadonlyMap<string, string>
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
  const merged = [...builtin, ...mcp] as unknown[]
  // B1：出向 sanitize 是单向有损转换，这里同步产出 compat 名 → 内部名的逆映射；
  // 两个内部名归一为同一 compat 名（如 'a.b' 与 'a_b'）属于配置错误，构建期报错。
  const compatToInternal = new Map<string, string>()
  for (const tool of merged) {
    const name = (tool as { name?: unknown }).name
    if (typeof name !== 'string' || !name) continue
    const compat = toolIdToOpenAiCompatibleApiToolName(name)
    const existing = compatToInternal.get(compat)
    if (existing && existing !== name) {
      throw new Error(`工具 compat 名撞名：'${existing}' 与 '${name}' 都归一为 '${compat}'；点号名与等价下划线名不可并存`)
    }
    compatToInternal.set(compat, name)
  }
  const tools = sanitizeAnthropicToolsPayloadForStrictGateways(merged)
  const toolNames = tools.flatMap((tool) => {
    const name = (tool as { name?: unknown }).name
    return typeof name === 'string' ? [name] : []
  })
  return {
    tools,
    toolNames,
    // 白名单为内部名口径：分发循环先把 API 返回名逆映射回内部名再校验（B1）
    authorizedToolNames: new Set(compatToInternal.values()),
    compatToInternal
  }
}

export function authorizeToolCall(toolName: string, authorizedToolNames: ReadonlySet<string>):
  | { ok: true }
  | { ok: false; error: 'tool_not_authorized' } {
  return authorizedToolNames.has(toolName) ? { ok: true } : { ok: false, error: 'tool_not_authorized' }
}
