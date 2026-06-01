import { useEffect, useState } from 'react'
import { useTypedSelector } from '../../hooks'
import { useResolvedTheme, type ResolvedTheme } from '../../theme/useResolvedTheme'
import { highlightCode } from '../../utils/shikiHighlighter'

type BodyProps = {
  code: string
  language: string
  theme: ResolvedTheme
  className?: string
  fallbackClassName?: string
}

export function ShikiHighlightedCodeBody({
  code,
  language,
  theme,
  className,
  fallbackClassName = 'tool-code-preview'
}: BodyProps) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void highlightCode(code, language, theme).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  if (html) {
    return (
      <div className={className}>
        <div className="sa-prose" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    )
  }

  return <pre className={fallbackClassName}>{code}</pre>
}

type Props = Omit<BodyProps, 'theme'>

export function ShikiHighlightedCode(props: Props) {
  const uiTheme = useTypedSelector((s) => s.config.config?.uiTheme ?? 'system')
  const resolved = useResolvedTheme(uiTheme)
  return <ShikiHighlightedCodeBody {...props} theme={resolved} />
}
