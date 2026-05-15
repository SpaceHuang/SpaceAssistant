export type SearchOptions = {
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

export type SearchMatch = {
  start: number
  end: number
}

function buildPattern(query: string, options: SearchOptions): string {
  let pattern = options.useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (options.wholeWord && !options.useRegex) {
    pattern = `\\b${pattern}\\b`
  }
  return pattern
}

export function getSearchRegexError(query: string, options: SearchOptions): string | null {
  if (!query || !options.useRegex) return null
  try {
    const flags = options.caseSensitive ? 'g' : 'gi'
    new RegExp(buildPattern(query, options), flags)
    return null
  } catch {
    return '正则表达式无效'
  }
}

export function buildSearchRegex(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null
  const err = getSearchRegexError(query, options)
  if (err) return null
  try {
    const flags = options.caseSensitive ? 'g' : 'gi'
    return new RegExp(buildPattern(query, options), flags)
  } catch {
    return null
  }
}

export function findSearchMatches(content: string, query: string, options: SearchOptions): SearchMatch[] {
  const regex = buildSearchRegex(query, options)
  if (!regex) return []
  const matches: SearchMatch[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex += 1
      continue
    }
    matches.push({ start: m.index, end: m.index + m[0].length })
  }
  return matches
}

export function replaceAll(content: string, query: string, replacement: string, options: SearchOptions): string {
  const regex = buildSearchRegex(query, options)
  if (!regex) return content
  return content.replace(regex, replacement)
}

export function replaceOneAt(
  content: string,
  match: SearchMatch,
  replacement: string,
  query: string,
  options: SearchOptions
): string {
  const slice = content.slice(match.start, match.end)
  if (options.useRegex) {
    try {
      let pattern = query
      if (options.wholeWord) pattern = `\\b${pattern}\\b`
      const flags = options.caseSensitive ? '' : 'i'
      const re = new RegExp(pattern, flags)
      return content.slice(0, match.start) + slice.replace(re, replacement) + content.slice(match.end)
    } catch {
      return content
    }
  }
  return content.slice(0, match.start) + replacement + content.slice(match.end)
}
