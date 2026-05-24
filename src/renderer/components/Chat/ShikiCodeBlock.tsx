import { useEffect, useState } from 'react'
import { Button } from 'antd'
import { Copy } from 'lucide-react'
import { useTypedSelector } from '../../hooks'
import { useResolvedTheme } from '../../theme/useResolvedTheme'
import { highlightCode } from '../../utils/shikiHighlighter'

type Props = {
  code: string
  language: string
}

export function ShikiCodeBlock({ code, language }: Props) {
  const uiTheme = useTypedSelector((s) => s.config.config?.uiTheme ?? 'system')
  const resolved = useResolvedTheme(uiTheme)
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void highlightCode(code, language, resolved).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, language, resolved])

  const isLight = resolved === 'light'

  return (
    <div className="sa-shiki-block" style={{ position: 'relative' }}>
      <Button
        type="text"
        size="small"
        icon={<Copy size={14} />}
        className="sa-shiki-copy"
        style={{ position: 'absolute', right: 8, top: 8, zIndex: 1 }}
        onClick={() => void navigator.clipboard.writeText(code)}
      >
        复制
      </Button>
      {html ? (
        <div className="sa-prose" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre
          className="tool-code-preview"
          style={{
            background: isLight ? '#ffffff' : undefined,
            color: isLight ? '#24292f' : undefined
          }}
        >
          {code}
        </pre>
      )}
    </div>
  )
}
