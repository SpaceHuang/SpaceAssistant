import { useMemo } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { summarizeLarkCliConfirmInput } from '../../../shared/larkCliDisplay'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

export function LarkCliConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const summary = useMemo(() => summarizeLarkCliConfirmInput(record.input), [record.input])
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const allowLabel = summary.isWriteOperation ? t('confirm.lark.allowWrite') : t('confirm.lark.allowCommand')
  const denyLabel = summary.isWriteOperation ? t('confirm.lark.denyWrite') : t('confirm.lark.denyCommand')

  return (
    <div className="write-confirm-card lark-cli-confirm-card">
      <ConfirmCardDecision
        actionSummary={summary.headline}
        allowLabel={allowLabel}
        denyLabel={denyLabel}
        onConfirm={onConfirm}
        badges={
          summary.isWriteOperation ? (
            <span className="write-confirm-card__stat write-confirm-card__stat--write">{t('confirm.lark.writeBadge')}</span>
          ) : undefined
        }
      >
        <div className="write-confirm-card__subject lark-cli-confirm-card__subject">
          <pre className="write-confirm-card__subject-value write-confirm-card__subject-value--code" title={summary.command}>
            <code className="lark-cli-confirm-card__command-line">{summary.command}</code>
          </pre>
          <p className="write-confirm-card__subject-note lark-cli-confirm-card__hint">{summary.hint}</p>
          {timeout !== undefined ? (
            <div className="lark-cli-confirm-card__meta">
              <span className="lark-cli-confirm-card__meta-item">
                <span className="lark-cli-confirm-card__meta-key">timeout</span>
                <span className="lark-cli-confirm-card__meta-value">{timeout}s</span>
              </span>
            </div>
          ) : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
