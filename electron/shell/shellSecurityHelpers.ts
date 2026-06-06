export function extractCommandName(command: string): string {
  const trimmed = command.trim()
  const firstSegment = trimmed.split(/\s*(?:&&|\|\||;|\|)\s*/)[0]?.trim() ?? trimmed
  const firstToken = firstSegment.split(/\s+/)[0] ?? ''
  return firstToken.replace(/^.*[/\\]/, '').toLowerCase()
}

export function extractRmPathArguments(command: string): string[] {
  const paths: string[] = []
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/)
  for (const seg of segments) {
    const tokens = tokenizeArgs(seg.trim())
    if (tokens[0]?.toLowerCase() !== 'rm') continue
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!
      if (t.startsWith('-')) continue
      paths.push(t)
    }
  }
  return paths
}

function tokenizeArgs(segment: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) tokens.push(cur)
  return tokens
}

export function normalizeRmPath(pathArg: string): string {
  const normalized = pathArg.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || '/'
}

export function isFatalRmTarget(pathArg: string, _platform: NodeJS.Platform): boolean {
  const normalized = normalizeRmPath(pathArg)
  const fatalPatterns = [
    /^\/$/,
    /^\/\*$/,
    /^[a-zA-Z]:\/$/,
    /^[a-zA-Z]:\/\*$/,
    /^~$/,
    /^\$HOME$/i,
    /^%USERPROFILE%$/i,
    /^\.$/,
    /^\.\.$/,
    /^\*$/
  ]
  return fatalPatterns.some((pattern) => pattern.test(normalized))
}

export function hasRmRecursiveFlag(command: string): boolean {
  const lower = command.toLowerCase()
  if (!/\brm\b/.test(lower)) return false
  if (/(?:^|\s)-rf\b/.test(lower)) return true
  if (/(?:^|\s)-r(?:\s+|$)/.test(lower) && /(?:^|\s)-f\b/.test(lower)) return true
  if (/(?:^|\s)-f(?:\s+|$)/.test(lower) && /(?:^|\s)-r\b/.test(lower)) return true
  return false
}
