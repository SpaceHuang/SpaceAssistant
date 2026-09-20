import { MAX_TOOL_RESULT_CONTENT_CHARS } from './toolResultLimits'

/** Distinguishes oversized omission from SYNTHETIC_TOOL_RESULT_PLACEHOLDER (missing result). */
export const OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX = '[tool_result omitted: content exceeded limit;'

export function formatOversizedToolResultPlaceholder(
  originalLength: number,
  maxChars: number = MAX_TOOL_RESULT_CONTENT_CHARS
): string {
  return `${OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX} originalLength=${originalLength}; maxChars=${maxChars}]`
}

export function isOversizedToolResultPlaceholder(content: string): boolean {
  return content.startsWith(OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX)
}

/** P1-4：中段截断标记前缀（幂等判定用）。 */
export const TRUNCATED_TOOL_RESULT_MARKER_PREFIX = '…[tool_result truncated:'

/**
 * 已截断内容的幂等识别：必须同时满足「含 marker」与「长度不超过上限 + 容差」。
 * 仅 includes 会让天然包含 marker 字面量的超限原文（如 grep 本仓库源码）跳过压缩，
 * 最坏 2 MiB 原文进上下文（评审 P1-2）；真截断产物长度必 ≤ maxChars（marker 预算内）。
 */
export function isTruncatedToolResultContent(content: string, maxChars: number = MAX_TOOL_RESULT_CONTENT_CHARS): boolean {
  return content.includes(TRUNCATED_TOOL_RESULT_MARKER_PREFIX) && content.length <= maxChars + TRUNCATION_MARKER_BUDGET
}

export interface CompactOversizedToolResultResult {
  content: string
  compacted: boolean
  originalLength: number
}

/**
 * Compresses tool_result content that exceeds the limit (P1-4：中段截断，保留头 + 尾 +
 * 截断标记；旧版「全有或全无」占位符与既有截断结果均幂等跳过).
 * Idempotent for already-compacted placeholders.
 */
export function compactOversizedToolResultContent(
  content: string,
  maxChars: number = MAX_TOOL_RESULT_CONTENT_CHARS
): CompactOversizedToolResultResult {
  const originalLength = content.length
  if (isOversizedToolResultPlaceholder(content) || isTruncatedToolResultContent(content, maxChars) || originalLength <= maxChars) {
    return { content, compacted: false, originalLength }
  }
  return { content: truncateMiddle(content, maxChars), compacted: true, originalLength }
}

/** 中段截断预算：标记块固定占用，剩余按 70/30 分给头/尾（尾部信息对「文件末尾形态」更关键）。 */
const TRUNCATION_MARKER_BUDGET = 400
const TRUNCATION_HEAD_RATIO = 0.7

function truncateMiddle(content: string, maxChars: number): string {
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER_BUDGET)
  const headLength = Math.floor(budget * TRUNCATION_HEAD_RATIO)
  const tailLength = budget - headLength
  const head = content.slice(0, headLength)
  const tail = tailLength > 0 ? content.slice(-tailLength) : ''
  const omitted = originalMiddleLength(content.length, headLength, tailLength)
  const marker = `${TRUNCATED_TOOL_RESULT_MARKER_PREFIX} ${omitted} chars omitted in the middle; originalLength=${content.length}; estimatedTokens=${Math.ceil(content.length / 3.5)}; totalLines=${content.split('\n').length}; maxChars=${maxChars}]…\n如需完整内容，使用 read_file 带 offset/limit 读取指定区间。`
  return `${head}${marker}${tail}`
}

function originalMiddleLength(totalLength: number, headLength: number, tailLength: number): number {
  return Math.max(0, totalLength - headLength - tailLength)
}
