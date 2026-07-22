import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import type { Message } from '../../shared/domainTypes'
import type { DisplayMessageEntry } from '../../shared/displayOrder'
import type { SearchOptions } from '../components/DetailPanel/searchUtils'
import { findSearchMatches } from '../components/DetailPanel/searchUtils'
import { useSearch } from '../components/Search/SearchProvider'
import {
  buildSearchFragmentsFromMessages,
  type ChatSearchMatch,
  type SearchFragment
} from '../../shared/chatSearchFragments'
import { capMatches, clearDomHighlights, effectiveSearchOptions, scrollHighlightIntoView } from './domSearchUtils'
import { resolveNavigationTarget } from './chatSearchNavigation'
import {
  applyActiveTargetHighlight,
  clearFragmentHighlights,
  resolveChatSearchActiveTarget,
  type ChatSearchActiveTarget
} from './chatSearchActiveTarget'
import { projectMarkdownForSearch } from './markdownSearchProjection'
import i18n from '../i18n'

export type StructuredSearchResult = {
  matches: ChatSearchMatch[]
  overflow: boolean
  fragments: SearchFragment[]
}

export function buildChatSearchFragments(entries: DisplayMessageEntry[]): SearchFragment[] {
  return buildSearchFragmentsFromMessages(entries, {
    projectMarkdown: projectMarkdownForSearch,
    t: (key, options) => i18n.t(key, { ns: 'chat', ...options })
  })
}

export function searchChatFragments(
  fragments: SearchFragment[],
  query: string,
  options: SearchOptions
): StructuredSearchResult {
  if (!query.trim()) {
    return { matches: [], overflow: false, fragments }
  }

  const effectiveOptions = effectiveSearchOptions(query, options)
  const rawMatches: ChatSearchMatch[] = []

  for (const fragment of fragments) {
    const localMatches = findSearchMatches(fragment.searchableText, query, effectiveOptions)
    for (const match of localMatches) {
      rawMatches.push({
        fragmentId: fragment.fragmentId,
        messageId: fragment.messageId,
        order: fragment.order,
        start: match.start,
        end: match.end
      })
    }
  }

  const capped = capMatches(rawMatches)
  return {
    matches: capped.matches,
    overflow: capped.overflow,
    fragments
  }
}

export function searchChatMessageEntries(
  entries: DisplayMessageEntry[],
  query: string,
  options: SearchOptions
): StructuredSearchResult {
  const fragments = buildChatSearchFragments(entries)
  return searchChatFragments(fragments, query, options)
}

const INPUT_DEBOUNCE_MS = 150
const INPUT_DEBOUNCE_HEAVY_MS = 300
const SEARCH_WARN_MS = 200
const HEAVY_MESSAGE_THRESHOLD = 500
const READY_RETRY_MS = 50
const READY_TIMEOUT_MS = 1000

type Options = {
  containerRef: RefObject<HTMLElement | null>
  active: boolean
  entries: DisplayMessageEntry[]
  messageCount?: number
  onNavigateToMatch?: (messageId: string) => void
}

export function messagesToDisplayEntries(messages: Message[]): DisplayMessageEntry[] {
  return messages.map((message, index) => ({
    message,
    order: { kind: 'persisted', sequence: index }
  }))
}

export function useChatStructuredSearchAdapter({
  containerRef,
  active,
  entries,
  messageCount = entries.length,
  onNavigateToMatch
}: Options) {
  const {
    isOpen,
    query,
    options,
    panelSupported,
    matchIndex,
    regexError,
    setSearchResults,
    setUpdating,
    registerClearHighlights,
    setActiveTarget
  } = useSearch()

  const matchesRef = useRef<ChatSearchMatch[]>([])
  const fragmentsRef = useRef<SearchFragment[]>([])
  const activeTargetRef = useRef<ChatSearchActiveTarget | null>(null)
  const signatureRef = useRef('')
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const matchIndexRef = useRef(matchIndex)
  matchIndexRef.current = matchIndex
  const lastNavigatedIndexRef = useRef(-1)

  const entriesSignature = useMemo(
    () =>
      entries
        .map(({ message, order }) => {
          const orderKey = order.kind === 'persisted' ? `p:${order.sequence}` : `o:${order.ordinal}`
          return `${message.id}:${orderKey}:${message.content.length}:${message.status}`
        })
        .join('\n'),
    [entries]
  )

  const inputDebounceMs =
    messageCount > HEAVY_MESSAGE_THRESHOLD ? INPUT_DEBOUNCE_HEAVY_MS : INPUT_DEBOUNCE_MS

  const clearHighlights = useCallback(() => {
    const container = containerRef.current
    if (container) {
      clearFragmentHighlights(container)
      clearDomHighlights(container)
    }
    matchesRef.current = []
    fragmentsRef.current = []
    activeTargetRef.current = null
    signatureRef.current = ''
    setActiveTarget(null)
    if (readyTimerRef.current) {
      clearTimeout(readyTimerRef.current)
      readyTimerRef.current = null
    }
  }, [containerRef, setActiveTarget])

  const tryApplyActiveTargetHighlight = useCallback(
    (target: ChatSearchActiveTarget | null, opts?: { scroll?: boolean }) => {
      const container = containerRef.current
      if (!container || !target) return false
      clearFragmentHighlights(container)
      const mark = applyActiveTargetHighlight(container, target)
      if (mark && opts?.scroll !== false) scrollHighlightIntoView(mark)
      return mark != null
    },
    [containerRef]
  )

  const publishActiveTarget = useCallback(
    (index: number) => {
      const match = resolveNavigationTarget(matchesRef.current, index)
      const target = resolveChatSearchActiveTarget(match, fragmentsRef.current)
      activeTargetRef.current = target
      setActiveTarget(target)
      if (!target) return

      onNavigateToMatch?.(target.messageId)

      const started = performance.now()
      const attempt = () => {
        if (activeTargetRef.current?.fragmentId !== target.fragmentId) return
        if (tryApplyActiveTargetHighlight(target)) return
        if (performance.now() - started >= READY_TIMEOUT_MS) {
          // 超时：保留消息行定位与 reveal，片段容器级 fallback 由 apply 内部处理
          tryApplyActiveTargetHighlight(target)
          return
        }
        readyTimerRef.current = setTimeout(attempt, READY_RETRY_MS)
      }
      if (readyTimerRef.current) clearTimeout(readyTimerRef.current)
      attempt()
    },
    [onNavigateToMatch, setActiveTarget, tryApplyActiveTargetHighlight]
  )

  const runSearch = useCallback(() => {
    if (!active) {
      clearHighlights()
      return
    }

    const container = containerRef.current
    if (!isOpen || !panelSupported || !container) {
      clearHighlights()
      setSearchResults({ totalMatches: 0, matchOverflow: false })
      setUpdating(false)
      return
    }

    if (!query.trim() || regexError) {
      clearHighlights()
      setSearchResults({ totalMatches: 0, matchOverflow: false })
      setUpdating(false)
      return
    }

    const started = performance.now()
    const structured = searchChatMessageEntries(entries, query, options)
    const signature = `${query}\u0000${JSON.stringify(options)}\u0000${entriesSignature}`
    const contentChanged = signature !== signatureRef.current

    if (contentChanged) {
      matchesRef.current = structured.matches
      fragmentsRef.current = structured.fragments
      signatureRef.current = signature
      lastNavigatedIndexRef.current = -1
      setSearchResults({
        totalMatches: structured.matches.length,
        matchOverflow: structured.overflow
      })

      if (structured.matches.length === 0) {
        activeTargetRef.current = null
        setActiveTarget(null)
        clearFragmentHighlights(container)
      } else {
        const index = matchIndexRef.current < 0 ? 0 : matchIndexRef.current
        lastNavigatedIndexRef.current = index
        publishActiveTarget(index)
      }
    }

    setUpdating(false)

    const elapsed = performance.now() - started
    if (elapsed > SEARCH_WARN_MS) {
      console.warn(`[SearchBar] structured chat search took ${elapsed.toFixed(1)}ms`)
    }
  }, [
    active,
    clearHighlights,
    containerRef,
    entries,
    entriesSignature,
    isOpen,
    options,
    panelSupported,
    publishActiveTarget,
    query,
    regexError,
    setActiveTarget,
    setSearchResults,
    setUpdating
  ])

  const scheduleSearch = useCallback(
    (delay = inputDebounceMs) => {
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current)
      inputTimerRef.current = setTimeout(() => {
        inputTimerRef.current = null
        runSearch()
      }, delay)
    },
    [inputDebounceMs, runSearch]
  )

  useEffect(() => {
    if (isOpen && active && panelSupported) {
      registerClearHighlights(clearHighlights)
    } else {
      registerClearHighlights(null)
    }
    return () => registerClearHighlights(null)
  }, [active, clearHighlights, isOpen, panelSupported, registerClearHighlights])

  useEffect(() => {
    if (!active) {
      if (inputTimerRef.current) {
        clearTimeout(inputTimerRef.current)
        inputTimerRef.current = null
      }
      clearHighlights()
      return
    }
    if (!isOpen || !panelSupported) {
      clearHighlights()
      return
    }
    setUpdating(true)
    scheduleSearch(0)
    return () => {
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current)
    }
  }, [
    isOpen,
    active,
    panelSupported,
    query,
    options,
    regexError,
    entriesSignature,
    scheduleSearch,
    clearHighlights,
    setUpdating
  ])

  useEffect(() => {
    if (!isOpen || !active || !panelSupported) return
    if (matchIndex < 0) return
    if (lastNavigatedIndexRef.current === matchIndex && activeTargetRef.current) {
      // entries 变化后 fragment 可能刚挂载，重试高亮
      tryApplyActiveTargetHighlight(activeTargetRef.current)
      return
    }
    if (lastNavigatedIndexRef.current === matchIndex) return
    lastNavigatedIndexRef.current = matchIndex
    publishActiveTarget(matchIndex)
  }, [
    matchIndex,
    isOpen,
    active,
    panelSupported,
    entriesSignature,
    publishActiveTarget,
    tryApplyActiveTargetHighlight
  ])

  useEffect(() => {
    return () => {
      clearHighlights()
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current)
      if (readyTimerRef.current) clearTimeout(readyTimerRef.current)
    }
  }, [clearHighlights])
}
