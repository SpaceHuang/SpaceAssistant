import { useEffect, useRef, useState } from 'react'
import { getCachedHighlight, highlightCode } from '../../utils/shikiHighlighter'

type BodyProps = {
  code: string
  language: string
  className?: string
  fallbackClassName?: string
}

export function ShikiHighlightedCodeBody({
  code,
  language,
  className,
  fallbackClassName = 'tool-code-preview'
}: BodyProps) {
  const [html, setHtml] = useState<string | null>(() => getCachedHighlight(code, language))
  const requestIdRef = useRef(0)

  useEffect(() => {
    const cached = getCachedHighlight(code, language)
    if (cached) {
      setHtml(cached)
      return
    }

    const requestId = ++requestIdRef.current
    void highlightCode(code, language).then((result) => {
      if (requestId !== requestIdRef.current || !result) return
      setHtml(result)
    })
  }, [code, language])

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
