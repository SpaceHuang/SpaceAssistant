function prefixUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value)
  let end = Math.min(bytes.length, maxBytes)
  while (end > 0) {
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, end)); return { text, truncated: end < bytes.length } } catch { end -= 1 }
  }
  return { text: '', truncated: value.length > 0 }
}

export function buildMcpCopyText(display: { text?: string; structured?: unknown; structuredText?: string; blocks?: Array<{ kind: string; uri?: string; name?: string; mimeType?: string; byteLength?: number; raw?: string }>; truncated?: boolean; structuredTruncated?: boolean }, maxBytes: number): { text: string; truncated: boolean } {
    const structured = display.structuredText !== undefined ? `\n\n${display.structuredText}` : display.structured === undefined ? '' : `\n\n${JSON.stringify(display.structured, null, 2)}`
  const blocks = (display.blocks ?? []).filter((block) => block.kind !== 'text').map((block) => {
    if (block.kind === 'resource') return `[资源] ${block.name ?? block.uri ?? ''}${block.uri ? ` (${block.uri})` : ''}`
    if (block.kind === 'image') return `[图片] ${block.mimeType ?? '未知类型'}，${block.byteLength ?? 0} bytes`
    return `[其他结果] ${block.raw ?? ''}`
  }).join('\n')
  const full = `${display.text ?? ''}${structured}${blocks ? `\n\n${blocks}` : ''}`
  const marker = '\n[结果已截断]'
  const encodedMarker = new TextEncoder().encode(marker).byteLength
  const result = prefixUtf8(full, Math.max(0, maxBytes - encodedMarker))
  const truncated = result.truncated || Boolean(display.truncated || display.structuredTruncated)
  return truncated ? { text: `${result.text}${marker}`, truncated: true } : { text: result.text, truncated: false }
}
