/** Removes multimodal and binary payloads before transcript text reaches a summarizer. */
export function safeSummaryText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeSummaryText)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.type === 'image' || record.type === 'image_url') return { type: record.type, note: 'image payload omitted from text summary' }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [
      key,
      ['data', 'base64', 'bytes'].includes(key.toLowerCase()) ? '[binary payload omitted]' : safeSummaryText(item)
    ]))
  }
  return value
}

export function safeSummaryContentText(content: unknown): string {
  if (typeof content === 'string') return content
  return JSON.stringify(safeSummaryText(content)) ?? ''
}
