import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import {
  effectiveSearchOptions,
  containsCjk
} from '../../services/domSearchUtils'
import {
  getSearchRegexError,
  type SearchOptions
} from '../DetailPanel/searchUtils'

export type ActivePanel = 'chat' | 'file-markdown' | 'file-source' | 'unsupported'

export type SearchResults = {
  totalMatches: number
  matchOverflow: boolean
}

type SearchContextValue = {
  isOpen: boolean
  query: string
  options: SearchOptions
  activePanel: ActivePanel
  panelSupported: boolean
  matchIndex: number
  totalMatches: number
  matchOverflow: boolean
  isUpdating: boolean
  regexError: string | null
  wholeWordDisabled: boolean
  focusToken: number
  open: () => void
  close: () => void
  setQuery: (query: string) => void
  toggleOption: (key: keyof SearchOptions) => void
  goNext: () => void
  goPrev: () => void
  setSearchResults: (results: SearchResults) => void
  setUpdating: (updating: boolean) => void
  registerClearHighlights: (fn: (() => void) | null) => void
}

const SearchContext = createContext<SearchContextValue | null>(null)

function resolveActivePanel(input: {
  selectedFile: string | null
  contentMode: 'file' | 'url'
  fileType: string | null
  viewMode: 'code' | 'render'
  isWebViewActive: boolean
}): { panel: ActivePanel; supported: boolean } {
  const { selectedFile, contentMode, fileType, viewMode, isWebViewActive } = input

  if (contentMode === 'url' || isWebViewActive) {
    return { panel: 'unsupported', supported: false }
  }
  if (!selectedFile) {
    return { panel: 'chat', supported: true }
  }
  if (fileType === 'image' || fileType === 'unsupported') {
    return { panel: 'unsupported', supported: false }
  }
  if (fileType === 'markdown' && viewMode === 'render') {
    return { panel: 'file-markdown', supported: true }
  }
  return { panel: 'file-source', supported: false }
}

function isComposerFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  return el.closest('.composer') !== null
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const {
    selectedFile,
    contentMode,
    fileType,
    viewMode,
    isWebViewActive
  } = useDetailPanel()

  const [isOpen, setIsOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    useRegex: false
  })
  const [matchIndex, setMatchIndex] = useState(-1)
  const [totalMatches, setTotalMatches] = useState(0)
  const [matchOverflow, setMatchOverflow] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  const clearHighlightsRef = useRef<(() => void) | null>(null)

  const { panel: activePanel, supported: panelSupported } = useMemo(
    () =>
      resolveActivePanel({
        selectedFile,
        contentMode,
        fileType,
        viewMode,
        isWebViewActive
      }),
    [selectedFile, contentMode, fileType, viewMode, isWebViewActive]
  )

  const effectiveOptions = useMemo(() => effectiveSearchOptions(query, options), [query, options])
  const wholeWordDisabled = containsCjk(query)
  const regexError = useMemo(() => {
    if (!query) return null
    return getSearchRegexError(query, effectiveOptions)
  }, [query, effectiveOptions])

  const clearHighlights = useCallback(() => {
    clearHighlightsRef.current?.()
  }, [])

  const close = useCallback(() => {
    clearHighlights()
    setIsOpen(false)
    setMatchIndex(-1)
    setTotalMatches(0)
    setMatchOverflow(false)
    setIsUpdating(false)
  }, [clearHighlights])

  const open = useCallback(() => {
    const selection = window.getSelection()?.toString() ?? ''
    if (selection.trim()) {
      setQueryState(selection)
    }
    setIsOpen(true)
    setFocusToken((n) => n + 1)
  }, [])

  const setQuery = useCallback((value: string) => {
    setQueryState(value)
  }, [])

  const toggleOption = useCallback((key: keyof SearchOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const goNext = useCallback(() => {
    if (totalMatches <= 0 || regexError) return
    setMatchIndex((index) => {
      if (index < 0) return 0
      return index >= totalMatches - 1 ? 0 : index + 1
    })
  }, [totalMatches, regexError])

  const goPrev = useCallback(() => {
    if (totalMatches <= 0 || regexError) return
    setMatchIndex((index) => {
      if (index < 0) return totalMatches - 1
      return index <= 0 ? totalMatches - 1 : index - 1
    })
  }, [totalMatches, regexError])

  const setSearchResults = useCallback((results: SearchResults) => {
    setTotalMatches((prev) => (prev === results.totalMatches ? prev : results.totalMatches))
    setMatchOverflow((prev) => (prev === results.matchOverflow ? prev : results.matchOverflow))
    setMatchIndex((current) => {
      if (results.totalMatches === 0) return current === -1 ? current : -1
      const next = current < 0 || current >= results.totalMatches ? 0 : current
      return next === current ? current : next
    })
  }, [])

  const registerClearHighlights = useCallback((fn: (() => void) | null) => {
    clearHighlightsRef.current = fn
  }, [])

  const setUpdating = useCallback((updating: boolean) => {
    setIsUpdating((prev) => (prev === updating ? prev : updating))
  }, [])

  useEffect(() => {
    if (!panelSupported) {
      clearHighlights()
      setMatchIndex(-1)
      setTotalMatches(0)
      setMatchOverflow(false)
      setIsUpdating(false)
    }
  }, [panelSupported, activePanel, clearHighlights])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey

      if (isOpen && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }

      if (!mod || e.key.toLowerCase() !== 'f') return
      if (isComposerFocused()) return

      if (activePanel === 'file-source') return

      if (activePanel === 'unsupported') return

      if (activePanel === 'chat' || activePanel === 'file-markdown') {
        e.preventDefault()
        e.stopPropagation()
        open()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [activePanel, close, isOpen, open])

  const value = useMemo<SearchContextValue>(
    () => ({
      isOpen,
      query,
      options,
      activePanel,
      panelSupported,
      matchIndex,
      totalMatches,
      matchOverflow,
      isUpdating,
      regexError,
      wholeWordDisabled,
      focusToken,
      open,
      close,
      setQuery,
      toggleOption,
      goNext,
      goPrev,
      setSearchResults,
      setUpdating,
      registerClearHighlights
    }),
    [
      isOpen,
      query,
      options,
      activePanel,
      panelSupported,
      matchIndex,
      totalMatches,
      matchOverflow,
      isUpdating,
      regexError,
      wholeWordDisabled,
      focusToken,
      open,
      close,
      setQuery,
      toggleOption,
      goNext,
      goPrev,
      setSearchResults,
      setUpdating,
      registerClearHighlights
    ]
  )

  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>
}

export function useSearch(): SearchContextValue {
  const ctx = useContext(SearchContext)
  if (!ctx) {
    throw new Error('useSearch must be used within SearchProvider')
  }
  return ctx
}
