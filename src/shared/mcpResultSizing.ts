export type McpResultDisplayMode = 'short' | 'medium' | 'long' | 'huge'

export function classifyMcpResultSize(renderTextChars: number, hasOversizedNonTextContent: boolean): McpResultDisplayMode {
  if (hasOversizedNonTextContent || renderTextChars > 512 * 1024) return 'huge'
  if (renderTextChars > 64 * 1024) return 'long'
  if (renderTextChars > 8 * 1024) return 'medium'
  return 'short'
}
