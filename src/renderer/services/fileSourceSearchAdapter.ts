import { useEffect, useMemo } from 'react'
import { findSearchMatches } from '../components/DetailPanel/searchUtils'
import { useSearch } from '../components/Search/SearchProvider'
import { capMatches, effectiveSearchOptions } from './domSearchUtils'

/** 源码模式：在 previewContent 字符串上搜索，供 CodeView 高亮与 SearchBar 计数同步。 */
export function useFileSourceSearch(content: string) {
  const {
    activePanel,
    isOpen,
    query,
    options,
    regexError,
    matchIndex,
    setSearchResults,
    setUpdating
  } = useSearch()

  const active = activePanel === 'file-source'
  const effectiveOptions = useMemo(() => effectiveSearchOptions(query, options), [query, options])

  const matches = useMemo(() => {
    if (!active || !isOpen || !query.trim() || regexError) return []
    return findSearchMatches(content, query, effectiveOptions)
  }, [active, content, effectiveOptions, isOpen, query, regexError])

  useEffect(() => {
    if (!active) return
    if (!isOpen || !query.trim() || regexError) {
      setSearchResults({ totalMatches: 0, matchOverflow: false })
      setUpdating(false)
      return
    }
    const capped = capMatches(matches)
    setSearchResults({ totalMatches: capped.matches.length, matchOverflow: capped.overflow })
    setUpdating(false)
  }, [active, isOpen, matches, query, regexError, setSearchResults, setUpdating])

  return {
    matches: active && isOpen && !regexError ? matches : [],
    currentIndex: active && isOpen && matchIndex >= 0 ? matchIndex : -1
  }
}
