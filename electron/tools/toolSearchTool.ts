import { createSnapshotReadRegisteredTool } from './snapshotReadRegisteredTool'
import type { ToolExecutorResult, ToolExecutionContext } from './types'
import type { McpToolSnapshot, McpToolSnapshotEntry } from '../mcp/mcpToolRegistry'

/**
 * tool_search 元工具执行器（FR2 / §6.3，需求：MCP 工具延迟加载）。
 * 纯函数检索装配期冻结的 MCP 快照；schema 永不截断，返回体总量 ≤32 KiB（溢出响应）。
 * 匹配用大小写不敏感子串（String.includes），全程无正则——从根上规避 ReDoS（评审 O6 的意图）。
 */

export const TOOL_SEARCH_MAX_BYTES = 32 * 1024
const TOOL_SEARCH_QUERY_MAX = 256
const TOOL_SEARCH_LIMIT_DEFAULT = 5
const TOOL_SEARCH_LIMIT_MAX = 10
/** 发现期描述已被 validateMcpToolSchema 截到 4,000 字符；此处按快照原文返回，仅溢出响应时逐级收缩。 */
const TOOL_SEARCH_DESC_STEPS = [4000, 1000, 300, 0] as const

const USAGE_HINT = '上列工具的参数 schema（input_schema）已随本结果下发，下一轮可直接调用；未列出的工具请换关键词继续检索。'
const USAGE_TRUNCATED_NOTE = '返回体已达上限，其余命中未列出：请缩小 query、指定 server 参数，或用 offset 翻页。'
const USAGE_CONDENSED_NOTE = '部分条目描述因返回体上限被精简，完整能力以 input_schema 为准。'
const EMPTY_HINT = 'tool_search 没有匹配的 MCP 工具。建议：换更短的关键词继续用 tool_search 检索、查看系统提示中的「MCP 工具索引」、或省略 query 分页列出全部；若要查询产品自身能力（非 MCP），请改用 toolkit_find。'

export type ToolSearchMatch = {
  name: string
  server: string
  description: string
  input_schema: Record<string, unknown>
}

export type ToolSearchResult = {
  matches: ToolSearchMatch[]
  totalMatches: number
  truncated: boolean
  usage: string
}

/** 大小写不敏感子串匹配（无正则）。 */
function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

type ScoredEntry = { entry: McpToolSnapshotEntry; score: number; wordHits: number }

/**
 * 检索打分：名字命中（mappedName/originalName）> 描述/服务名命中；
 * 多词命中数在同分内排前；完全相同分数保持快照顺序（稳定排序）。
 */
function rankEntries(entries: McpToolSnapshotEntry[], terms: string[]): ScoredEntry[] {
  const scored: Array<ScoredEntry & { index: number }> = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const nameTarget = `${entry.mappedName}\n${entry.originalName}`
    const descTarget = `${entry.serverName}\n${entry.description}`
    let nameHits = 0
    let descHits = 0
    for (const term of terms) {
      if (contains(nameTarget, term)) nameHits += 1
      else if (contains(descTarget, term)) descHits += 1
    }
    if (nameHits === 0 && descHits === 0) continue
    scored.push({ entry, score: nameHits > 0 ? 2 : 1, wordHits: nameHits + descHits, index })
  }
  return scored
    .sort((a, b) => b.score - a.score || b.wordHits - a.wordHits || a.index - b.index)
    .map(({ entry, score, wordHits }) => ({ entry, score, wordHits }))
}

/** 序列化体积（与仓库 trimMcpToolsForBudget 同口径：JSON 字符数）。 */
function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function toMatch(entry: McpToolSnapshotEntry, descriptionLimit: number): ToolSearchMatch {
  return {
    name: entry.mappedName,
    server: entry.serverName || entry.serverId,
    description: entry.description.slice(0, descriptionLimit),
    input_schema: entry.inputSchema
  }
}

/**
 * 溢出响应装载（§6.3）：32 KiB 总预算内按匹配排名逐条装入（体积按完整返回信封计）；
 * 第 K 条放不下时先逐级收缩该条描述（input_schema 永不截断），仍不足则停止追加并置 truncated。
 * 单工具 schema ≤16 KiB（发现期护栏），因此预算内至少能完整装入 1 条。
 */
function loadWithBudget(scored: ScoredEntry[], limit: number, totalMatches: number, offset: number): { matches: ToolSearchMatch[]; truncated: boolean; condensed: boolean } {
  const matches: ToolSearchMatch[] = []
  let condensed = false
  let volumeTruncated = false
  const envelopeLength = (list: ToolSearchMatch[]) => serializedLength({
    matches: list, totalMatches, truncated: true, usage: USAGE_HINT + USAGE_TRUNCATED_NOTE + USAGE_CONDENSED_NOTE
  })
  for (const { entry } of scored.slice(0, limit)) {
    const candidate = toMatch(entry, TOOL_SEARCH_DESC_STEPS[0]!)
    if (envelopeLength([...matches, candidate]) <= TOOL_SEARCH_MAX_BYTES) {
      matches.push(candidate)
      continue
    }
    let placed = false
    for (const step of TOOL_SEARCH_DESC_STEPS.slice(1)) {
      const shrunk = toMatch(entry, step)
      if (envelopeLength([...matches, shrunk]) <= TOOL_SEARCH_MAX_BYTES) {
        matches.push(shrunk)
        condensed = true
        placed = true
        break
      }
    }
    if (!placed) volumeTruncated = true
    break
  }
  // truncated 语义 =「本次返回未覆盖全部命中」：体积触顶，或分页后仍有剩余（遍历保底依赖它翻页）
  const truncated = volumeTruncated || offset + matches.length < totalMatches
  return { matches, truncated, condensed }
}

/** tool_search 检索（纯函数；快照经 context.mcpToolSnapshot 注入，装配期冻结）。 */
export function executeToolSearch(
  input: Record<string, unknown>,
  context: Pick<ToolExecutionContext, 'mcpToolSnapshot'>
): ToolSearchResult {
  const snapshot: McpToolSnapshot | undefined = context.mcpToolSnapshot
  const all = [...(snapshot?.entries.values() ?? [])]

  const rawQuery = typeof input.query === 'string' ? input.query : ''
  const query = rawQuery.slice(0, TOOL_SEARCH_QUERY_MAX)
  const rawServer = typeof input.server === 'string' ? input.server.trim() : ''
  const rawLimit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : TOOL_SEARCH_LIMIT_DEFAULT
  const limit = Math.min(TOOL_SEARCH_LIMIT_MAX, Math.max(1, rawLimit))
  const rawOffset = typeof input.offset === 'number' && Number.isFinite(input.offset) ? Math.trunc(input.offset) : 0
  const offset = Math.max(0, rawOffset)

  // server 过滤：按名称或 id，大小写不敏感精确匹配
  const filtered = rawServer
    ? all.filter((entry) => entry.serverName === rawServer || entry.serverId === rawServer ||
        entry.serverName.toLowerCase() === rawServer.toLowerCase() || entry.serverId.toLowerCase() === rawServer.toLowerCase())
    : all

  const terms = query.split(/\s+/).filter(Boolean)
  const scored = terms.length > 0 ? rankEntries(filtered, terms) : filtered.map((entry, index) => ({ entry, score: 1, wordHits: 0, index }))
  const totalMatches = scored.length
  const paged = scored.slice(offset)

  if (totalMatches === 0 || paged.length === 0) {
    return { matches: [], totalMatches, truncated: false, usage: terms.length > 0 ? EMPTY_HINT : `本会话共 ${totalMatches} 个工具，当前分页为空：请减小 offset。` }
  }

  const { matches, truncated, condensed } = loadWithBudget(paged, limit, totalMatches, offset)
  const usage = [USAGE_HINT, ...(truncated ? [USAGE_TRUNCATED_NOTE] : []), ...(condensed ? [USAGE_CONDENSED_NOTE] : [])].join('\n')
  return { matches, totalMatches, truncated, usage }
}

/** 注册形态：只读（actionClass 'read'）自动放行，不进审批流（FR2）。 */
export const toolSearchTool = createSnapshotReadRegisteredTool('tool_search', async (input, context) => {
  const result = executeToolSearch(input, context)
  return { success: true, data: result } satisfies ToolExecutorResult
})
