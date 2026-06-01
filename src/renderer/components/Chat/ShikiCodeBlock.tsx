import { Button } from 'antd'
import { Copy } from 'lucide-react'
import { ShikiHighlightedCode } from './ShikiHighlightedCode'

type Props = {
  code: string
  language: string
}

export function ShikiCodeBlock({ code, language }: Props) {
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
      <ShikiHighlightedCode code={code} language={language} />
    </div>
  )
}
