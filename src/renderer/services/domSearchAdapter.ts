import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { findSearchMatches, type SearchMatch } from '../components/DetailPanel/searchUtils'
import { useSearch } from '../components/Search/SearchProvider'
import {
  applyDomHighlights,
  capMatches,
  clearDomHighlights,
  effectiveSearchOptions,
  extractDomSearchText,
  HIGHLIGHT_CLASS,
  mapMatchesToDom,
  scrollHighlightIntoView,
  updateCurrentHighlight
} from './domSearchUtils'

const INPUT_DEBOUNCE_MS = 150
const INPUT_DEBOUNCE_HEAVY_MS = 300
const MUTATION_DEBOUNCE_MS = 300
const SEARCH_WARN_MS = 200
const HEAVY_MESSAGE_THRESHOLD = 500

type Options = {
  containerRef: RefObject<HTMLElement | null>
  active: boolean
  blockSelector?: string
  messageCount?: number
  /** 仅聊天流式内容需要；静态 Markdown 关闭以避免无意义重搜。 */
  watchMutations?: boolean
}

export function useDomSearchAdapter({
  containerRef,
  active,
  blockSelector,
  messageCount = 0,
  watchMutations = true
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
    registerClearHighlights
  } = useSearch()

  const marksRef = useRef<HTMLElement[]>([])
  const matchesRef = useRef<SearchMatch[]>([])
  const signatureRef = useRef('')
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mutationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)
  const mutationPendingRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const suppressMutationRef = useRef(false)
  const matchIndexRef = useRef(matchIndex)
  matchIndexRef.current = matchIndex
  const lastNavigatedIndexRef = useRef(-1)

  const inputDebounceMs =
    messageCount > HEAVY_MESSAGE_THRESHOLD ? INPUT_DEBOUNCE_HEAVY_MS : INPUT_DEBOUNCE_MS

  const clearHighlights = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      marksRef.current = []
      matchesRef.current = []
      signatureRef.current = ''
      return
    }
    suppressMutationRef.current = true
    try {
      clearDomHighlights(container)
    } finally {
      suppressMutationRef.current = false
    }
    marksRef.current = []
    matchesRef.current = []
    signatureRef.current = ''
  }, [containerRef])

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
    const effectiveOptions = effectiveSearchOptions(query, options)

    const extracted = extractDomSearchText(container, { blockSelector, includeHighlightText: true })
    const text = extracted.text
    const rawMatches = findSearchMatches(text, query, effectiveOptions)
    const capped = capMatches(rawMatches)
    const matches = capped.matches
    const overflow = capped.overflow

    const signature = `${query}\u0000${JSON.stringify(effectiveOptions)}\u0000${text}`
    const contentChanged = signature !== signatureRef.current

    if (contentChanged) {
      suppressMutationRef.current = true
      try {
        clearDomHighlights(container)
        const fresh = extractDomSearchText(container, { blockSelector, includeHighlightText: false })
        const freshCapped = capMatches(findSearchMatches(fresh.text, query, effectiveOptions))
        const freshDomMatches = mapMatchesToDom(fresh.offsetMap, freshCapped.matches)
        marksRef.current = applyDomHighlights(container, freshDomMatches, 0, { skipClear: true })
      } finally {
        suppressMutationRef.current = false
      }
      signatureRef.current = signature
      matchesRef.current = matches
      lastNavigatedIndexRef.current = -1
      setSearchResults({
        totalMatches: matches.length,
        matchOverflow: overflow
      })
    }

    setUpdating(false)

    const elapsed = performance.now() - started
    if (elapsed > SEARCH_WARN_MS) {
      console.warn(`[SearchBar] DOM search took ${elapsed.toFixed(1)}ms`)
    }
  }, [
    active,
    blockSelector,
    clearHighlights,
    containerRef,
    isOpen,
    options,
    panelSupported,
    query,
    regexError,
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
    scheduleSearch(0)
    return () => {
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current)
    }
  }, [isOpen, active, panelSupported, query, options, regexError, scheduleSearch, clearHighlights])

  useEffect(() => {
    if (!isOpen || !active || !panelSupported) return
    if (marksRef.current.length === 0 || matchIndex < 0) return
    if (lastNavigatedIndexRef.current === matchIndex) return
    lastNavigatedIndexRef.current = matchIndex
    updateCurrentHighlight(marksRef.current, matchIndex)
    scrollHighlightIntoView(marksRef.current[matchIndex])
  }, [matchIndex, isOpen, active, panelSupported])

  useEffect(() => {
    if (!watchMutations || !isOpen || !active || !panelSupported) {
      mutationObserverRef.current?.disconnect()
      mutationObserverRef.current = null
      return
    }

    const container = containerRef.current
    if (!container) return

    const observer = new MutationObserver((records) => {
      if (suppressMutationRef.current) return
      if (records.every(isSearchHighlightMutation)) return
      if (frameRef.current != null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        mutationPendingRef.current = true
        setUpdating(true)
        if (mutationTimerRef.current) clearTimeout(mutationTimerRef.current)
        mutationTimerRef.current = setTimeout(() => {
          mutationTimerRef.current = null
          mutationPendingRef.current = false
          scheduleSearch(0)
        }, MUTATION_DEBOUNCE_MS)
      })
    })

    observer.observe(container, { childList: true, subtree: true, characterData: true })
    mutationObserverRef.current = observer

    return () => {
      observer.disconnect()
      if (mutationTimerRef.current) clearTimeout(mutationTimerRef.current)
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    }
  }, [active, containerRef, isOpen, panelSupported, scheduleSearch, setUpdating, watchMutations])

  useEffect(() => {
    return () => {
      clearHighlights()
      if (inputTimerRef.current) clearTimeout(inputTimerRef.current)
      if (mutationTimerRef.current) clearTimeout(mutationTimerRef.current)
    }
  }, [clearHighlights])
}

function isSearchHighlightMutation(record: MutationRecord): boolean {
  const markSelector = `mark.${HIGHLIGHT_CLASS}`
  const target = record.target
  if (target instanceof Element) {
    if (target.classList.contains(HIGHLIGHT_CLASS)) return true
    if (target.closest(markSelector)) return true
  }
  if (record.type === 'childList') {
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (node instanceof Element) {
        if (node.classList.contains(HIGHLIGHT_CLASS) || node.matches?.(markSelector)) return true
        if (node.querySelector?.(markSelector)) return true
      }
    }
  }
  return false
}
