import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { X } from 'lucide-react'
import {
  findSearchMatches,
  getSearchRegexError,
  type SearchMatch,
  type SearchOptions
} from './searchUtils'

type Props = {
  open: boolean
  onClose: () => void
  onHighlightsChange: (matches: SearchMatch[], currentIndex: number) => void
}

export function SearchPanel({ open, onClose, onHighlightsChange }: Props) {
  const { previewContent, fileType, viewMode } = useDetailPanel()
  const [query, setQuery] = useState('')
  const [currentIndex, setCurrentIndex] = useState(0)
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    useRegex: false
  })

  const content = previewContent ?? ''
  const searchable = fileType !== 'image' && fileType !== 'unsupported' && viewMode !== 'render'

  const regexError = useMemo(() => {
    if (!searchable || !query) return null
    return getSearchRegexError(query, options)
  }, [searchable, query, options])

  const matches = useMemo(() => {
    if (!searchable || !query || regexError) return []
    return findSearchMatches(content, query, options)
  }, [content, query, options, searchable, regexError])

  useEffect(() => {
    setCurrentIndex(matches.length > 0 ? 0 : -1)
  }, [matches.length, query, options.caseSensitive, options.wholeWord, options.useRegex])

  useEffect(() => {
    onHighlightsChange(matches, currentIndex)
  }, [matches, currentIndex, onHighlightsChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        setOptions((o) => ({ ...o, caseSensitive: !o.caseSensitive }))
      }
      if (e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        setOptions((o) => ({ ...o, wholeWord: !o.wholeWord }))
      }
      if (e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        setOptions((o) => ({ ...o, useRegex: !o.useRegex }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!open || !searchable) return null

  const goPrev = () => {
    if (matches.length === 0) return
    setCurrentIndex((i) => (i <= 0 ? matches.length - 1 : i - 1))
  }

  const goNext = () => {
    if (matches.length === 0) return
    setCurrentIndex((i) => (i >= matches.length - 1 ? 0 : i + 1))
  }

  const countLabel =
    matches.length === 0 ? '0 / 0' : `${currentIndex + 1} / ${matches.length}`

  return (
    <div className="detail-search-panel">
      <div className="detail-search-row">
        <Input
          size="small"
          placeholder="查找"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          status={regexError ? 'error' : undefined}
          autoFocus
        />
        <div className="detail-search-options">
          <button
            type="button"
            className={`detail-search-opt${options.caseSensitive ? ' active' : ''}`}
            title="大小写匹配 (Alt+C)"
            onClick={() => setOptions((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
          >
            Aa
          </button>
          <button
            type="button"
            className={`detail-search-opt${options.wholeWord ? ' active' : ''}`}
            title="整词匹配 (Alt+W)"
            onClick={() => setOptions((o) => ({ ...o, wholeWord: !o.wholeWord }))}
          >
            W
          </button>
          <button
            type="button"
            className={`detail-search-opt${options.useRegex ? ' active' : ''}`}
            title="正则表达式 (Alt+R)"
            onClick={() => setOptions((o) => ({ ...o, useRegex: !o.useRegex }))}
          >
            .*
          </button>
        </div>
        <Typography.Text type="secondary" className="detail-search-count">
          {countLabel}
        </Typography.Text>
        <Button size="small" type="text" onClick={goPrev} disabled={matches.length === 0}>
          ↑
        </Button>
        <Button size="small" type="text" onClick={goNext} disabled={matches.length === 0}>
          ↓
        </Button>
        <button type="button" className="detail-toolbar-btn" title="关闭" onClick={onClose}>
          <X className="detail-toolbar-icon" size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {regexError && (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {regexError}
        </Typography.Text>
      )}
    </div>
  )
}
