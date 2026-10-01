import type { PromptSection } from './promptAssembly'
import { skillCatalogBudget } from './promptAssembly'

/**
 * MCP 工具索引区块（FR1 / FR4 / §6.2，需求：MCP 工具延迟加载）。
 * 与 buildSkillCatalogSection 同构：只列「name + 服务名 + 一句话描述」的轻量索引，
 * 完整 schema 经 tool_search 检索后按需下发。索引是截断视图而非准入名单——
 * 被截断工具仍可被全文检索发现。
 */

/** 索引条目的最小结构（主进程 McpToolSnapshotEntry 结构兼容，避免 shared 反向依赖 electron）。 */
export type McpCatalogEntry = {
  mappedName: string
  serverName: string
  serverId?: string
  description: string
}

const MCP_CATALOG_DESC_MAX = 120
/** 与 skillPrompt 的字符预算口径一致（token × 3.5）。 */
const CHARS_PER_TOKEN = 3.5

function catalogLine(entry: McpCatalogEntry): string {
  const firstLine = entry.description.split('\n', 1)[0] ?? ''
  return `- ${entry.mappedName}（${entry.serverName || entry.serverId || ''}）：${firstLine.slice(0, MCP_CATALOG_DESC_MAX)}`
}

/**
 * 构建「## MCP 工具索引」区块；无延迟工具时返回 null，不产生空区块。
 * 预算复用 skillCatalogBudget(contextWindow) 口径，按行累加截断；
 * 头部注明「共 N 个工具，已列出前 K 个」，截断时尾部追加检索提示。
 */
export function buildMcpToolCatalogSection(
  entries: readonly McpCatalogEntry[],
  contextWindow: number
): PromptSection | null {
  if (entries.length === 0) return null
  const budget = skillCatalogBudget(contextWindow)
  const maxChars = Math.max(0, budget * CHARS_PER_TOKEN)
  const lines: string[] = []
  let bodyChars = 0
  for (const entry of entries) {
    const line = catalogLine(entry)
    const candidate = bodyChars + line.length + (lines.length > 0 ? 1 : 0)
    if (lines.length > 0 && candidate > maxChars) break
    lines.push(line)
    bodyChars = candidate
  }
  const listed = lines.length
  const truncated = listed < entries.length
  const header = `## MCP 工具索引（共 ${entries.length} 个工具，已列出 ${listed} 个）`
  const tail = truncated ? '\n（更多工具请用 tool_search 检索）' : ''
  return { name: 'mcp:catalog', order: 45, text: `${header}\n\n${lines.join('\n')}${tail}` }
}
