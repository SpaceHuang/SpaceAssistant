const MCP_SENSITIVE_RANGE_PATTERNS: Array<{ pattern: RegExp; group?: number }> = [
  { pattern: /["'](?:authorization|proxy-authorization)["']\s*:\s*["']?[^\s\r\n"']+\s+((?:\\.|[^"\r\n])*)/gi, group: 1 },
  { pattern: /(?:^|\r?\n)\s*(?:Authorization|Proxy-Authorization)\s*:\s*Digest\s+([^\r\n]*)/gim, group: 1 },
  { pattern: /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?!Digest\b)[^\s\r\n:]+\s+([^\s,;"']+)/gi, group: 1 },
  { pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]+)/gi, group: 1 },
  { pattern: /\bsk-[A-Za-z0-9_-]+\b/g },
  { pattern: /\bghp_[A-Za-z0-9]+\b/g },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/g },
  { pattern: /\bglpat-[A-Za-z0-9_-]+\b/g },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { pattern: /\b[a-f0-9]{32,}\b/gi }
]

export function findSensitiveTextRanges(input: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const { pattern, group } of MCP_SENSITIVE_RANGE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of input.matchAll(pattern)) {
      const value = group ? match[group] : match[0]
      if (!value) continue
      const start = match.index! + (group ? match[0].lastIndexOf(value) : 0)
      ranges.push({ start, end: start + value.length })
    }
  }
  return ranges.sort((a, b) => a.start - b.start).reduce<Array<{ start: number; end: number }>>((merged, range) => {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
    return merged
  }, [])
}

export function maskSensitiveText(input: string): string {
  const ranges = findSensitiveTextRanges(input)
  if (ranges.length === 0) return input
  const parts: string[] = []
  let cursor = 0
  for (const range of ranges) {
    parts.push(input.slice(cursor, range.start), '<secret:redacted>')
    cursor = range.end
  }
  parts.push(input.slice(cursor))
  return parts.join('')
}

/** 在不改变 Markdown 业务实体的前提下，掩码实体编码的已知凭据。 */
export function maskSensitiveMarkdownText(input: string): string {
  const entity = '(?:&#95;|&#x5f;|&#x5F;|_)'
  const encodedToken = new RegExp(`\\bghp${entity}[A-Za-z0-9]+\\b`, 'g')
  const encodedPrefixed = new RegExp(`\\b(?:sk|glpat|xox[baprs])(?:&#45;|&#x2d;|&#x2D;|-)\\S+`, 'gi')
  const normalized = input
    .replace(encodedToken, (value) => value.replace(/&#(?:95|x5f);/gi, '_'))
    .replace(encodedPrefixed, (value) => value.replace(/&#(?:45|x2d);/gi, '-'))
  return maskSensitiveText(normalized)
}

export function maskSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return '<structured depth omitted>'
  if (typeof value === 'string') return maskSensitiveText(value)
  if (Array.isArray(value)) return value.map((item) => maskSensitiveValue(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const isAuthorization = /^(?:proxy-)?authorization$/i.test(key)
      if (isAuthorization && typeof item === 'string') {
        const scheme = item.trim().split(/\s+/, 1)[0] ?? ''
        return [key, `${scheme} <secret:redacted>`]
      }
      // 键名保持原样，避免多个被掩码的 token 键发生 Object.fromEntries 碰撞；
      // structuredText 序列化后会对键名和值统一做最终文本掩码。
      return [key, maskSensitiveValue(item, depth + 1)]
    }))
  }
  return value
}
