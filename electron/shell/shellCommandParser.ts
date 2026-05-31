const MAX_SEGMENTS = 50

const SPLIT_RE = /&&|\|\||[|;]/g

/** 将复合 shell 命令分段（引号内不拆分）。 */
export function parseShellSegments(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return ['']

  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (quote) {
      current += ch
      if (ch === quote && trimmed[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '&' && trimmed[i + 1] === '&') {
      pushSegment(segments, current)
      current = ''
      i++
      continue
    }
    if (ch === '|' && trimmed[i + 1] === '|') {
      pushSegment(segments, current)
      current = ''
      i++
      continue
    }
    if (ch === '|' || ch === ';') {
      pushSegment(segments, current)
      current = ''
      continue
    }
    current += ch
  }
  pushSegment(segments, current)

  if (segments.length > MAX_SEGMENTS) {
    throw new Error(`命令段数过多（>${MAX_SEGMENTS}），请拆分为多条命令`)
  }
  return segments
}

function pushSegment(segments: string[], raw: string): void {
  const s = raw.trim()
  if (s || segments.length === 0) segments.push(s)
}
