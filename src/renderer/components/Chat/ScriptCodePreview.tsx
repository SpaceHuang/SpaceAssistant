import { useMemo } from 'react'
import { ShikiHighlightedCode } from './ShikiHighlightedCode'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

const PREVIEW_MAX_LINES = 120

type Props = {
  code: string
  maxLines?: number
  className?: string
}

function previewCode(code: string, maxLines: number, emptyLabel: string): string {
  if (!code) return emptyLabel
  const lines = code.split('\n')
  if (lines.length <= maxLines) return code
  return [...lines.slice(0, maxLines), '…'].join('\n')
}

export function ScriptCodePreview({ code, maxLines = PREVIEW_MAX_LINES, className }: Props) {
  const { t } = useTypedTranslation('chat')
  const emptyLabel = t('tool.empty')
  const displayCode = useMemo(() => previewCode(code, maxLines, emptyLabel), [code, maxLines, emptyLabel])

  return (
    <ShikiHighlightedCode
      code={displayCode}
      language="python"
      surface="light"
      className={['script-confirm-card__code', 'script-confirm-card__code--highlighted', className]
        .filter(Boolean)
        .join(' ')}
    />
  )
}

export function ScriptTimeoutMeta({ timeout }: { timeout: number }) {
  return (
    <div className="script-confirm-card__meta">
      <span className="script-confirm-card__meta-item">
        <span className="script-confirm-card__meta-key">timeout</span>
        <span className="script-confirm-card__meta-value">{timeout}s</span>
      </span>
    </div>
  )
}
