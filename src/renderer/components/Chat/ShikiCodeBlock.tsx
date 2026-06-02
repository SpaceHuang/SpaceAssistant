import { Button } from 'antd'
import { Copy } from 'lucide-react'
import { ShikiHighlightedCode } from './ShikiHighlightedCode'

type Props = {
  code: string
  language: string
}

export function ShikiCodeBlock({ code, language }: Props) {
  return (
    <div className="sa-shiki-block sa-code-surface sa-subtle-scrollbar">
      <Button
        type="text"
        size="small"
        icon={<Copy size={14} />}
        className="sa-shiki-copy"
        onClick={() => void navigator.clipboard.writeText(code)}
      >
        复制
      </Button>
      <ShikiHighlightedCode code={code} language={language} />
    </div>
  )
}
