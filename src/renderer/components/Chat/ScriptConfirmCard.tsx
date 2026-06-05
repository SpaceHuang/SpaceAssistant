import { useMemo } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { ShikiHighlightedCode } from './ShikiHighlightedCode'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

const PREVIEW_MAX_LINES = 120

export function ScriptConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const emptyLabel = t('tool.empty')

  const previewCode = (code: string): string => {
    if (!code) return emptyLabel
    const lines = code.split('\n')
    if (lines.length <= PREVIEW_MAX_LINES) return code
    return [...lines.slice(0, PREVIEW_MAX_LINES), '…'].join('\n')
  }

  const code = typeof record.input.code === 'string' ? record.input.code : ''
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const displayCode = useMemo(() => previewCode(code), [code, emptyLabel])

  return (
    <div className="write-confirm-card script-confirm-card">
      <ConfirmCardDecision
        actionSummary={t('confirm.script.actionSummary')}
        allowLabel={t('confirm.script.allow')}
        denyLabel={t('confirm.script.deny')}
        onConfirm={onConfirm}
      >
        <div className="write-confirm-card__subject script-confirm-card__subject">
          <div className="write-confirm-card__subject-value write-confirm-card__subject-value--code write-confirm-card__command--code">
            <ShikiHighlightedCode
              code={displayCode}
              language="python"
              surface="light"
              className="script-confirm-card__code script-confirm-card__code--highlighted"
            />
          </div>
          {timeout !== undefined ? (
            <div className="script-confirm-card__meta">
              <span className="script-confirm-card__meta-item">
                <span className="script-confirm-card__meta-key">timeout</span>
                <span className="script-confirm-card__meta-value">{timeout}s</span>
              </span>
            </div>
          ) : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
