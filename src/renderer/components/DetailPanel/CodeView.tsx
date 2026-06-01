import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { extToShikiLang } from '../../../shared/fileTypes'
import { highlightCode } from '../../utils/shikiHighlighter'
import type { SearchMatch } from './searchUtils'

type Props = {
  content: string
  filePath: string
  highlights?: SearchMatch[]
  currentHighlightIndex?: number
}

function renderWithHighlights(content: string, highlights: SearchMatch[], currentIndex: number) {
  if (highlights.length === 0) return content
  const parts: ReactNode[] = []
  let last = 0
  highlights.forEach((m, i) => {
    if (m.start > last) parts.push(content.slice(last, m.start))
    parts.push(
      <mark key={`${m.start}-${m.end}`} className={i === currentIndex ? 'detail-search-current' : 'detail-search-hit'}>
        {content.slice(m.start, m.end)}
      </mark>
    )
    last = m.end
  })
  if (last < content.length) parts.push(content.slice(last))
  return parts
}

export function CodeView({ content, filePath, highlights = [], currentHighlightIndex = -1 }: Props) {
  const [html, setHtml] = useState<string | null>(null)
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const lang = extToShikiLang(filePath)
  const lines = useMemo(() => content.split('\n'), [content])
  const usePlain = highlights.length > 0

  useEffect(() => {
    if (usePlain) {
      setHtml(null)
      return
    }
    let cancelled = false
    void highlightCode(content, lang).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [content, lang, usePlain])

  useEffect(() => {
    if (currentHighlightIndex < 0 || highlights.length === 0) return
    const match = highlights[currentHighlightIndex]
    if (!match) return
    const line = content.slice(0, match.start).split('\n').length - 1
    const el = lineRefs.current.get(line)
    el?.scrollIntoView({ block: 'center' })
  }, [content, currentHighlightIndex, highlights])

  if (usePlain) {
    return (
      <div className="detail-code-view">
        <div className="detail-code-gutter">
          {lines.map((_, i) => (
            <div key={i} className="detail-line-number" ref={(el) => (el ? lineRefs.current.set(i, el) : undefined)}>
              {i + 1}
            </div>
          ))}
        </div>
        <pre className="detail-code-content detail-code-plain">
          <code>{renderWithHighlights(content, highlights, currentHighlightIndex)}</code>
        </pre>
      </div>
    )
  }

  if (!html) {
    return (
      <div className="detail-code-view">
        <div className="detail-code-gutter">
          {lines.map((_, i) => (
            <div key={i} className="detail-line-number">
              {i + 1}
            </div>
          ))}
        </div>
        <pre className="detail-code-content detail-code-plain">
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="detail-code-view detail-code-shiki">
      <div className="detail-code-gutter">
        {lines.map((_, i) => (
          <div key={i} className="detail-line-number">
            {i + 1}
          </div>
        ))}
      </div>
      <div className="detail-code-content shiki-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
