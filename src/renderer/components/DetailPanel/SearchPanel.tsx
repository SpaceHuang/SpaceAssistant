import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Modal, Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { X } from 'lucide-react'
import {
  findSearchMatches,
  getSearchRegexError,
  replaceAll,
  replaceOneAt,
  type SearchMatch,
  type SearchOptions
} from './searchUtils'

export type SearchPanelMode = 'find' | 'replace' | null

type Props = {
  mode: SearchPanelMode
  onClose: () => void
  onHighlightsChange: (matches: SearchMatch[], currentIndex: number) => void
}

export function SearchPanel({ mode, onClose, onHighlightsChange }: Props) {
  const { previewContent, setPreviewContent, fileType, viewMode } = useDetailPanel()
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [currentIndex, setCurrentIndex] = useState(0)
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    useRegex: false
  })
  const [regexError, setRegexError] = useState<string | null>(null)

  const content = previewContent ?? ''
  const searchable = fileType !== 'image' && fileType !== 'unsupported' && viewMode !== 'render'

  const matches = useMemo(() => {
    if (!searchable || !query) {
      setRegexError(null)
      return []
    }
    const err = getSearchRegexError(query, options)
    setRegexError(err)
    if (err) return []
    return findSearchMatches(content, query, options)
  }, [content, query, options, searchable])

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

  if (!mode || !searchable) return null

  const goPrev = () => {
    if (matches.length === 0) return
    setCurrentIndex((i) => (i <= 0 ? matches.length - 1 : i - 1))
  }

  const goNext = () => {
    if (matches.length === 0) return
    setCurrentIndex((i) => (i >= matches.length - 1 ? 0 : i + 1))
  }

  const replaceCurrent = () => {
    if (currentIndex < 0 || !matches[currentIndex]) return
    const match = matches[currentIndex]
    const next = replaceOneAt(content, match, replacement, query, options)
    setPreviewContent(next)
  }

  const replaceAllConfirm = () => {
    if (matches.length === 0) return
    Modal.confirm({
      title: '全部替换',
      content: `确定要替换全部 ${matches.length} 处匹配项吗？`,
      okText: '替换',
      cancelText: '取消',
      onOk: () => {
        const next = replaceAll(content, query, replacement, options)
        setPreviewContent(next)
      }
    })
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
      {mode === 'replace' && (
        <div className="detail-search-row">
          <Input
            size="small"
            placeholder="替换为"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <Button size="small" onClick={replaceCurrent} disabled={matches.length === 0}>
            替换
          </Button>
          <Button size="small" onClick={replaceAllConfirm} disabled={matches.length === 0}>
            全部
          </Button>
        </div>
      )}
      {regexError && (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {regexError}
        </Typography.Text>
      )}
    </div>
  )
}
