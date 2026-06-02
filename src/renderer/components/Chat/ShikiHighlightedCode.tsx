import { useEffect, useRef, useState } from 'react'
import { getCachedHighlight, highlightCode, type ShikiSurface } from '../../utils/shikiHighlighter'

type BodyProps = {
  code: string
  language: string
  className?: string
  fallbackClassName?: string
  /** 默认 dark，与聊天区 --sa-code-bg 一致 */
  surface?: ShikiSurface
}

export function ShikiHighlightedCodeBody({
  code,
  language,
  className,
  fallbackClassName = 'sa-chat-code-block',
  surface = 'dark'
}: BodyProps) {
  const [html, setHtml] = useState<string | null>(() => getCachedHighlight(code, language, surface))
  const requestIdRef = useRef(0)

  useEffect(() => {
    const cached = getCachedHighlight(code, language, surface)
    if (cached) {
      setHtml(cached)
      return
    }

    const requestId = ++requestIdRef.current
    void highlightCode(code, language, surface).then((result) => {
      if (requestId !== requestIdRef.current || !result) return
      setHtml(result)
    })
  }, [code, language, surface])

  if (className) {
    return (
      <div className={className}>
        <div className="sa-prose">
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="shiki shiki-placeholder">
              <code>{code}</code>
            </pre>
          )}
        </div>
      </div>
    )
  }

  if (html) {
    return (
      <div className="sa-prose" dangerouslySetInnerHTML={{ __html: html }} />
    )
  }

  return <pre className={fallbackClassName}>{code}</pre>
}

type Props = Omit<BodyProps, never>

export function ShikiHighlightedCode(props: Props) {
  return <ShikiHighlightedCodeBody {...props} />
}
