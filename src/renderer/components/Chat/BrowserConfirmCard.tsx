import type { ToolCallRecord } from '../../../shared/domainTypes'
import { summarizeBrowserConfirmInput } from './browserConfirmDisplay'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

export function BrowserConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const summary = summarizeBrowserConfirmInput(record.input)
  if (!summary) return null

  return (
    <div className="write-confirm-card browser-confirm-card">
      <ConfirmCardDecision
        actionSummary={summary.headline}
        allowLabel={t('confirm.browser.allow')}
        denyLabel={t('confirm.browser.deny')}
        onConfirm={onConfirm}
      >
        <div className="write-confirm-card__subject">
          <p className="write-confirm-card__subject-value browser-confirm-card__url" title={summary.detailValue}>
            {summary.detailValue}
          </p>
          {summary.hint ? (
            <p className="write-confirm-card__subject-note browser-confirm-card__hint">{summary.hint}</p>
          ) : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
