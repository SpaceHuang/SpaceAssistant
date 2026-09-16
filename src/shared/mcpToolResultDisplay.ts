import { classifyMcpResultSize } from './mcpResultSizing'
import { maskSensitiveText, maskSensitiveValue } from './mcpSensitiveText'
import { sanitizeMcpResourceUri } from './mcpResourceUri'

export type SanitizedMcpBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; byteLength: number; data?: string; previewable: boolean }
  | { kind: 'resource'; uri: string; name?: string; mimeType?: string }
  | { kind: 'unknown'; raw: string }

export type McpResultBlock = SanitizedMcpBlock
export type McpResultDisplay = {
  text: string
  structured?: unknown
  structuredText?: string
  blocks: McpResultBlock[]
  structuredTruncated?: boolean
  unknownTruncated?: boolean
  truncated?: boolean
  isEmpty: boolean
  displayMode?: import('./mcpResultSizing').McpResultDisplayMode
  artifactId?: `artifact-mcp-${string}`
  artifactTruncated?: boolean
  artifactOwner?: { sessionId: string; assistantMessageId: string; toolUseId: string }
}

export type SanitizedMcpProjectionInput = { blocks: SanitizedMcpBlock[]; structured?: unknown }

function utf8Prefix(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (value.length <= maxBytes) return { value, truncated: false }
  return { value: value.slice(0, maxBytes), truncated: true }
}

export function projectSanitizedMcpBlocks(
  input: SanitizedMcpProjectionInput,
  limits: { maxTextBytes?: number; maxUnknownBytes?: number; maxBlocks?: number } = {}
): McpResultDisplay {
  const maxTextBytes = limits.maxTextBytes ?? 512 * 1024
  const maxUnknownBytes = limits.maxUnknownBytes ?? 16 * 1024
  let truncated = false
  let unknownTruncated = false
  let textBudget = maxTextBytes
  let unknownBudget = maxUnknownBytes
  let imageBudget = 512 * 1024
  let metadataBudget = 64 * 1024
  const maxBlocks = limits.maxBlocks ?? 128
  const omittedBlocks = Math.max(0, input.blocks.length - maxBlocks)
  const blocks = input.blocks.slice(0, maxBlocks).map((block) => {
    if (block.kind === 'image') {
      const keep = block.byteLength <= imageBudget
      imageBudget -= Math.min(block.byteLength, imageBudget)
      const mimeType = block.mimeType.slice(0, Math.min(256, Math.max(0, metadataBudget)))
      metadataBudget -= mimeType.length
      return keep ? { ...block, mimeType } : { ...block, mimeType, data: undefined, previewable: false }
    }
    if (block.kind === 'text') {
      const result = utf8Prefix(block.text, Math.max(0, textBudget))
      textBudget -= result.value.length
      truncated ||= result.truncated
      return { ...block, text: result.value }
    }
    if (block.kind === 'unknown') {
      const result = utf8Prefix(block.raw, Math.max(0, unknownBudget))
      unknownBudget -= result.value.length
      unknownTruncated ||= result.truncated
      return { ...block, raw: result.value }
    }
    if (block.kind === 'resource') {
      const uri = block.uri.slice(0, Math.min(block.uri.length, 2048))
      const name = block.name?.slice(0, 2048)
      const mimeType = block.mimeType?.slice(0, 256)
      const cost = uri.length + (name?.length ?? 0) + (mimeType?.length ?? 0)
      if (metadataBudget <= 0) return { kind: 'resource' as const, uri: '', name: '[资源元信息已省略]' }
      const allowed = Math.min(cost, metadataBudget)
      metadataBudget -= allowed
      return { ...block, uri: uri.slice(0, Math.min(uri.length, allowed)), name: name?.slice(0, Math.max(0, allowed - uri.length)), mimeType: mimeType?.slice(0, Math.max(0, allowed - uri.length - (name?.length ?? 0))) }
    }
    return block
  })
  if (omittedBlocks > 0) blocks.push({ kind: 'unknown', raw: `[${omittedBlocks} 个结果块已省略]` })
  // 块数量只约束 DOM 节点；正文摘要仍从全部文本块中提取，避免第 129 块的答案被丢弃。
  let aggregateBudget = maxTextBytes
  const textParts: string[] = []
  for (const block of input.blocks) {
    if (block.kind !== 'text' || !block.text || aggregateBudget <= 0) continue
    const part = utf8Prefix(block.text, aggregateBudget)
    textParts.push(part.value)
    aggregateBudget -= part.value.length
    truncated ||= part.truncated
  }
  const text = textParts.join('\n\n')
  let structuredText: string | undefined
  let structuredTruncated = false
  if (input.structured !== undefined) {
    try {
      const result = utf8Prefix(maskSensitiveText(JSON.stringify(input.structured, null, 2)), maxTextBytes)
      structuredText = result.value
      structuredTruncated = result.truncated
    } catch { structuredText = maskSensitiveText(String(input.structured)) }
  }
  const visibleChars = [text, structuredText].filter(Boolean).join('\n\n').length
  const hasVisibleBlock = blocks.some((block) => block.kind === 'text' ? Boolean(block.text) : block.kind === 'unknown' ? Boolean(block.raw) : true)
  const isEmpty = !hasVisibleBlock && !structuredText
  const hasOversizedNonTextContent = blocks.some((block) => block.kind !== 'text') && (unknownTruncated || blocks.some((block) => block.kind === 'image' && block.byteLength > 512 * 1024))
  return { text, structured: structuredTruncated ? undefined : input.structured, structuredText, blocks, truncated: (truncated || omittedBlocks > 0) || undefined, unknownTruncated: unknownTruncated || undefined, structuredTruncated: structuredTruncated || undefined, isEmpty, displayMode: classifyMcpResultSize(visibleChars, hasOversizedNonTextContent || truncated || unknownTruncated || structuredTruncated) }
}

/** 供历史消息和搜索共同使用的有界、脱敏基础投影。 */
export function projectPersistedMcpResult(data: unknown, limits?: { maxTextBytes?: number; maxUnknownBytes?: number }): McpResultDisplay {
  if (typeof data === 'string') return projectSanitizedMcpBlocks({ blocks: [{ kind: 'text', text: maskSensitiveText(data) }] }, limits)
  const envelope = data && typeof data === 'object' ? data as { content?: unknown; structuredContent?: unknown } : undefined
  const content = Array.isArray(data) ? data : Array.isArray(envelope?.content) ? envelope.content : undefined
  const isContentArray = Array.isArray(content) && (content.length === 0 || content.some((item) => item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string'))
  if (isContentArray) {
    const blocks = content.map((item) => {
      const block = item && typeof item === 'object' ? item as Record<string, unknown> : undefined
      if (block?.type === 'text' && typeof block.text === 'string') return { kind: 'text' as const, text: maskSensitiveText(block.text) }
      if (block?.type === 'resource_link') return { kind: 'resource' as const, uri: sanitizeMcpResourceUri(typeof block.uri === 'string' ? block.uri : ''), name: typeof block.name === 'string' ? maskSensitiveText(block.name).slice(0, 2048) : undefined, mimeType: typeof block.mimeType === 'string' ? maskSensitiveText(block.mimeType).slice(0, 256) : undefined }
      if (block?.type === 'resource') {
        const resource = block.resource && typeof block.resource === 'object' ? block.resource as Record<string, unknown> : block
        return { kind: 'resource' as const, uri: sanitizeMcpResourceUri(typeof resource.uri === 'string' ? resource.uri : ''), name: typeof block.name === 'string' ? maskSensitiveText(block.name).slice(0, 2048) : undefined, mimeType: typeof resource.mimeType === 'string' ? maskSensitiveText(resource.mimeType).slice(0, 256) : undefined }
      }
      return { kind: 'unknown' as const, raw: maskSensitiveText(JSON.stringify(item) ?? String(item)) }
    })
    return projectSanitizedMcpBlocks({ blocks, structured: maskSensitiveValue(envelope?.structuredContent) }, limits)
  }
  return projectSanitizedMcpBlocks({ blocks: [], structured: maskSensitiveValue(data) }, limits)
}
