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

export interface CompactOversizedToolResultResult {
  content: string
  compacted: boolean
  originalLength: number
}

/**
 * Compresses tool_result content that exceeds MAX_TOOL_RESULT_CONTENT_CHARS.
 * Idempotent for already-compacted placeholders.
 */
export function compactOversizedToolResultContent(
  content: string,
  maxChars: number = MAX_TOOL_RESULT_CONTENT_CHARS
): CompactOversizedToolResultResult {
  const originalLength = content.length
  if (isOversizedToolResultPlaceholder(content) || originalLength <= maxChars) {
    return { content, compacted: false, originalLength }
  }
  return {
    content: formatOversizedToolResultPlaceholder(originalLength, maxChars),
    compacted: true,
    originalLength
  }
}
