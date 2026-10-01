import type { PolicyRule } from '../src/shared/confirmation/types'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { snapshotEntriesToAnthropicTools, type McpToolSnapshot, type McpToolSnapshotEntry } from './mcp/mcpToolRegistry'
import { trimMcpToolsForBudget, MCP_TOOLS_PER_ROUND_MAX, MCP_TOOLS_TOTAL_BYTES_MAX, type McpServerProfile } from '../src/shared/mcpTypes'
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
  /** FR3：延迟名集合（不在广告面、在授权面）。非延迟模式恒为空集。 */
  deferredToolNames: ReadonlySet<string>
  /** FR12：eager 广告面裁剪记录（auto-eager / alwaysLoad 超限）；off 档（快照层已裁）恒空。与快照层 budgetDropped 命名区分。 */
  eagerBudgetDropped: Array<{ mappedName: string; reason: 'count' | 'bytes' }>
  /** O4（边界 11）：tool_search 被裁出广告面导致延迟计划整体失效、回退 eager 装配的标记。 */
  deferredDegradedToEager: boolean
}

/** eager 广告面预算（与快照层偏执上限无关，约束真正进上下文的部分）。 */
export type McpAdvertiseBudget = { maxCount: number; maxTotalBytes: number }

/**
 * FR5/§6.5：延迟加载计划（确定性、每 invoke 一次）。
 * eager 态携带 eagerAdvertiseBudget 表示「快照准入已放宽，广告面组装处需按既有预算裁剪」；
 * off 档不携带（快照层已按现状裁剪，computeEffectiveTools 不重复裁——10.1.1 逐字节兼容）。
 */
export type DeferredPlan =
  | { mode: 'eager'; eagerAdvertiseBudget?: McpAdvertiseBudget }
  | {
      mode: 'deferred'
      deferredNames: ReadonlySet<string>
      deferredEntries: McpToolSnapshotEntry[]
      /** alwaysLoad 服务条目的广告面预算（FR12：超限裁剪落 eagerBudgetDropped）。 */
      eagerAdvertiseBudget: McpAdvertiseBudget
    }

/** auto 档 eager 判定的数量条件（FR5/D8：字节与数量任一超出即延迟）。 */
const MCP_DEFERRED_EAGER_MAX_COUNT = MCP_TOOLS_PER_ROUND_MAX

export function computeDeferredPlan(args: {
  mcpSnapshot?: McpToolSnapshot
  profiles: McpServerProfile[]
  mode: 'auto' | 'always' | 'off'
  thresholdBytes: number
}): DeferredPlan {
  const entries = [...(args.mcpSnapshot?.entries.values() ?? [])]
  if (args.mode === 'off' || entries.length === 0) return { mode: 'eager' }

  const eagerBudget: McpAdvertiseBudget = { maxCount: MCP_TOOLS_PER_ROUND_MAX, maxTotalBytes: MCP_TOOLS_TOTAL_BYTES_MAX }
  const deferredEntries: McpToolSnapshotEntry[] = []
  let uncoveredCount = 0
  let uncoveredBytes = 0
  for (const entry of entries) {
    // alwaysLoad 服务永远 eager（FR6/§6.5 规则 2），其条目不入 deferred 集合
    const profile = args.profiles.find((p) => p.id === entry.serverId)
    if (profile?.enabled && profile.alwaysLoad === true) continue
    deferredEntries.push(entry)
    uncoveredCount += 1
    uncoveredBytes += JSON.stringify(entry).length
  }
  if (deferredEntries.length === 0) return { mode: 'eager' }
  if (args.mode === 'auto') {
    // auto：eager ⇔ 非覆盖条目总字节 ≤ 阈值 且 条目数 ≤ 64（任一超出 → 全部转延迟，不做单工具级拆分）
    if (uncoveredBytes <= args.thresholdBytes && uncoveredCount <= MCP_DEFERRED_EAGER_MAX_COUNT) {
      return { mode: 'eager', eagerAdvertiseBudget: eagerBudget }
    }
  }
  return {
    mode: 'deferred',
    deferredNames: new Set(deferredEntries.map((entry) => entry.mappedName)),
    deferredEntries,
    eagerAdvertiseBudget: eagerBudget
  }
}

/** P7 trim 对延迟名的约束（§6.6）：deny 剔除、allow 封闭集合仅保留命中者。 */
function applyTrimToDeferredNames(
  names: ReadonlySet<string>,
  trim?: { allow?: readonly string[]; deny?: readonly string[] }
): ReadonlySet<string> {
  if (!trim?.allow && !trim?.deny) return names
  const out = new Set<string>()
  for (const name of names) {
    if (trim.deny?.includes(name)) continue
    if (trim.allow && !trim.allow.includes(name)) continue
    out.add(name)
  }
  return out
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
  /** P7（偏差 16）：按调用裁剪——allow 为封闭集合（列表外一律无效），deny 只收窄。 */
  trim?: { allow?: readonly string[]; deny?: readonly string[] }
  /** FR5/§6.1：延迟加载计划（computeDeferredPlan 产出）。缺省 = 现状 eager 行为。 */
  deferredPlan?: DeferredPlan
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
  const plan = args.remoteContext ? undefined : args.deferredPlan
  const allEntries = [...(args.mcpSnapshot?.entries.values() ?? [])]
  const budget = plan?.eagerAdvertiseBudget

  let deferredNames: ReadonlySet<string> = new Set()
  let deferredDegradedToEager = false
  let advertiseEntries = allEntries
  // §6.5 规则 4：tool_search 仅在延迟计划生效时进广告面（eager 时绝不追加，不占广告面、
  // 保住 off 档与现状逐字节一致）；O4（边界 11）：tool_search 被 lane/开关/allowedTools 剔出
  // builtin 广告面时延迟计划整体失效回退 eager。
  let builtinAdvertised = builtin
  const toolSearchAvailable = builtin.some((tool) => tool.name === 'tool_search')
  const deferredActive = plan?.mode === 'deferred' && toolSearchAvailable
  if (!deferredActive) {
    builtinAdvertised = builtin.filter((tool) => tool.name !== 'tool_search')
  }
  if (plan?.mode === 'deferred') {
    if (!toolSearchAvailable) {
      deferredDegradedToEager = true
    } else {
      deferredNames = applyTrimToDeferredNames(plan.deferredNames, args.trim)
      // deferred 条目不进广告面；alwaysLoad 条目（及 trim 剔除的延迟名）留在广告面
      advertiseEntries = allEntries.filter((entry) => !plan.deferredNames.has(entry.mappedName))
    }
  }

  // FR11/O3：auto-eager 与 deferred（alwaysLoad 条目）的广告面按既有预算裁剪——
  // 与 off 档同函数同口径（trimMcpToolsForBudget 的 JSON.stringify(descriptor) 单位）；
  // off 档无 budget，快照层已裁（逐字节兼容），这里不再裁。
  let eagerBudgetDropped: Array<{ mappedName: string; reason: 'count' | 'bytes' }> = []
  if (budget) {
    const trimmed = trimMcpToolsForBudget(advertiseEntries as never, {
      maxCount: budget.maxCount,
      maxTotalBytes: budget.maxTotalBytes
    })
    advertiseEntries = trimmed.kept as never
    eagerBudgetDropped = trimmed.dropped.map((d) => ({ mappedName: d.tool.mappedName, reason: d.reason }))
  }

  const mcp = args.remoteContext
    ? []
    : snapshotEntriesToAnthropicTools(advertiseEntries)
  const merged = [...builtinAdvertised, ...mcp] as unknown[]
  // P7：按调用裁剪在 builtin/MCP 合成层统一执行（裁剪落工具集，不落提示词）
  const trimAllow = args.trim?.allow
  const trimDeny = args.trim?.deny
  const trimmed = (trimAllow || trimDeny)
    ? merged.filter((tool) => {
        const name = (tool as { name?: unknown }).name
        if (typeof name !== 'string') return false
        if (trimDeny?.includes(name)) return false
        if (trimAllow && !trimAllow.includes(name)) return false
        return true
      })
    : merged
  // B1：出向 sanitize 是单向有损转换，这里同步产出 compat 名 → 内部名的逆映射；
  // 两个内部名归一为同一 compat 名（如 'a.b' 与 'a_b'）属于配置错误，构建期报错。
  // O5（边界 2）：撞名守卫必须遍历含延迟名的完整集合（广告面 ∪ 延迟集），
  // 两个延迟名归一为同一 compat 名时静默覆盖会让回向解析错工具。
  const compatToInternal = new Map<string, string>()
  const deferredNameList = [...deferredNames]
  for (const tool of trimmed) {
    const name = (tool as { name?: unknown }).name
    if (typeof name !== 'string' || !name) continue
    const compat = toolIdToOpenAiCompatibleApiToolName(name)
    const existing = compatToInternal.get(compat)
    if (existing && existing !== name) {
      throw new Error(`工具 compat 名撞名：'${existing}' 与 '${name}' 都归一为 '${compat}'；点号名与等价下划线名不可并存`)
    }
    compatToInternal.set(compat, name)
  }
  for (const name of deferredNameList) {
    const compat = toolIdToOpenAiCompatibleApiToolName(name)
    const existing = compatToInternal.get(compat)
    if (existing && existing !== name) {
      throw new Error(`工具 compat 名撞名：'${existing}' 与 '${name}' 都归一为 '${compat}'；点号名与等价下划线名不可并存`)
    }
    compatToInternal.set(compat, name)
  }
  const tools = sanitizeAnthropicToolsPayloadForStrictGateways(trimmed)
  const toolNames = tools.flatMap((tool) => {
    const name = (tool as { name?: unknown }).name
    return typeof name === 'string' ? [name] : []
  })
  return {
    tools,
    toolNames,
    // 白名单为内部名口径：分发循环先把 API 返回名逆映射回内部名再校验（B1）
    // FR3：授权面 = 广告面 ∪ 延迟集（延迟工具保持可执行，透明兜底语义 D2）
    authorizedToolNames: new Set(compatToInternal.values()),
    compatToInternal,
    deferredToolNames: deferredDegradedToEager ? new Set() : deferredNames,
    eagerBudgetDropped,
    deferredDegradedToEager
  }
}

export function authorizeToolCall(toolName: string, authorizedToolNames: ReadonlySet<string>):
  | { ok: true }
  | { ok: false; error: 'tool_not_authorized' } {
  return authorizedToolNames.has(toolName) ? { ok: true } : { ok: false, error: 'tool_not_authorized' }
}
