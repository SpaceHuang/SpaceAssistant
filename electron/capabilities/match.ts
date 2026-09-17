import type { CapabilityDescriptor, CapabilityFamily, CapabilityIndexEntry } from './types'

/** 默认最多返回的匹配条数 */
export const MATCH_LIMIT = 3
/** 最低命中分数（一条 keyword 命中） */
export const MATCH_THRESHOLD = 2

const CJK_PATTERN = /[\u4e00-\u9fff]/

function isCjk(s: string): boolean {
  return CJK_PATTERN.test(s)
}

/** 分词：拉丁/数字词元 + CJK 连续段；统一小写。 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 0)
}

export interface CapabilityMatch {
  id: string
  summary: string
  score: number
}

export interface MatchOutcome {
  /** query 精确等于某能力 id */
  exact: boolean
  matches: CapabilityMatch[]
  /** 无命中时的全量紧凑索引，引导模型换词或直接按 id 调用 */
  index: CapabilityIndexEntry[]
}

/**
 * 确定性匹配（纯函数）：query 等于能力 id 时直接命中；否则按
 * 「id 命中 > summary 命中 > keywords 命中」加权打分，阈值截取。
 * 中文关键词靠包含关系命中（不做模糊语义匹配）。
 */
export function matchCapabilities(
  descriptors: readonly CapabilityDescriptor[],
  query: string,
  family?: CapabilityFamily
): MatchOutcome {
  const pool = family ? descriptors.filter((d) => d.family === family) : descriptors
  const normalizedQuery = query.trim().toLowerCase()

  const exact = pool.find((d) => d.id.toLowerCase() === normalizedQuery)
  if (exact) {
    return { exact: true, matches: [{ id: exact.id, summary: exact.summary, score: Number.MAX_SAFE_INTEGER }], index: [] }
  }

  const tokens = tokenize(query).filter((t) => t.length >= 2 || isCjk(t))
  const latinTokens = tokens.filter((t) => !isCjk(t))

  const scored: CapabilityMatch[] = []
  for (const d of pool) {
    let score = 0
    for (const token of latinTokens) {
      if (d.id.toLowerCase().includes(token)) {
        score += 5
        continue
      }
      if (d.summary.toLowerCase().includes(token)) {
        score += 3
        continue
      }
      if (d.keywords.some((k) => k.toLowerCase() === token)) {
        score += 2
      }
    }
    // 中文关键词：query 包含关键词即命中（每关键词计一次）
    for (const keyword of d.keywords) {
      if (isCjk(keyword) && normalizedQuery.includes(keyword.toLowerCase())) {
        score += 2
      }
    }
    if (score >= MATCH_THRESHOLD) scored.push({ id: d.id, summary: d.summary, score })
  }

  if (scored.length === 0) {
    return {
      exact: false,
      matches: [],
      index: pool.map((d) => ({ id: d.id, summary: d.summary }))
    }
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return { exact: false, matches: scored.slice(0, MATCH_LIMIT), index: [] }
}
