import i18n from '../../i18n'

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
    return i18n.t('detail.regexInvalid', { ns: 'search' })
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
