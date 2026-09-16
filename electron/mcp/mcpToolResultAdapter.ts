import { projectSanitizedMcpBlocks, type McpResultDisplay, type SanitizedMcpBlock } from '../../src/shared/mcpToolResultDisplay'
import { maskSensitiveText, maskSensitiveValue } from '../../src/shared/mcpSensitiveText'
import { validateMcpImage } from './mcpImageValidation'
import { sanitizeMcpResourceUri } from '../../src/shared/mcpResourceUri'

type Envelope = { __spaceAssistantMcpResult: 1; content?: unknown; structuredContent?: unknown }

function unknownBlock(value: unknown): SanitizedMcpBlock {
  let raw = ''
  try { raw = JSON.stringify(value) ?? String(value) } catch { raw = String(value) }
  return { kind: 'unknown', raw: maskSensitiveText(raw) }
}

function parseContent(content: unknown): SanitizedMcpBlock[] {
  if (!Array.isArray(content)) return [unknownBlock(content)]
  return content.map((item) => {
    if (!item || typeof item !== 'object' || typeof (item as { type?: unknown }).type !== 'string') return unknownBlock(item)
    const block = item as Record<string, unknown>
    switch (block.type) {
      case 'text': return typeof block.text === 'string' ? { kind: 'text', text: maskSensitiveText(block.text) } : unknownBlock(item)
      case 'image': {
        const rawMimeType = typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream'
        const image = typeof block.data === 'string' ? validateMcpImage(rawMimeType, block.data) : { byteLength: 0, previewable: false }
        return { kind: 'image', mimeType: maskSensitiveText(rawMimeType).slice(0, 256), ...image }
      }
      case 'resource': {
        const resource = block.resource && typeof block.resource === 'object' ? block.resource as Record<string, unknown> : block
        return { kind: 'resource', uri: typeof resource.uri === 'string' ? sanitizeMcpResourceUri(resource.uri) : '', name: typeof block.name === 'string' ? maskSensitiveText(block.name) : undefined, mimeType: typeof resource.mimeType === 'string' ? maskSensitiveText(resource.mimeType) : undefined }
      }
      case 'resource_link': return { kind: 'resource', uri: typeof block.uri === 'string' ? sanitizeMcpResourceUri(block.uri) : '', name: typeof block.name === 'string' ? maskSensitiveText(block.name) : undefined, mimeType: typeof block.mimeType === 'string' ? maskSensitiveText(block.mimeType) : undefined }
      default: {
        const unknown = unknownBlock(item)
        return unknown.kind === 'unknown' ? { ...unknown, raw: maskSensitiveText(unknown.raw) } : unknown
      }
    }
  })
}

export function adaptMcpToolResult(data: unknown, limits?: { maxTextBytes?: number; maxUnknownBytes?: number; maxBlocks?: number }): McpResultDisplay {
  if (data == null) return projectSanitizedMcpBlocks({ blocks: [] }, limits)
  if (typeof data === 'string') return projectSanitizedMcpBlocks({ blocks: [{ kind: 'text', text: data }] }, limits)
  if (Array.isArray(data) && (data.length === 0 || data.some((item) => item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string'))) {
    return projectSanitizedMcpBlocks({ blocks: parseContent(data) }, limits)
  }
  if (typeof data === 'object' && (data as Partial<Envelope>).__spaceAssistantMcpResult === 1) {
    const envelope = data as Envelope
    return projectSanitizedMcpBlocks({ blocks: envelope.content === undefined ? [] : parseContent(envelope.content), structured: maskSensitiveValue(envelope.structuredContent) }, limits)
  }
  return projectSanitizedMcpBlocks({ blocks: [], structured: maskSensitiveValue(data) }, limits)
}
