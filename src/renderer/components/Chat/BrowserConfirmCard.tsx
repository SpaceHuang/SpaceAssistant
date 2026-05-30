import { Globe } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { summarizeBrowserConfirmInput } from './browserConfirmDisplay'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

export function BrowserConfirmCard({ record, onConfirm }: Props) {
  const summary = summarizeBrowserConfirmInput(record.input)
  if (!summary) return null

  return (
    <div className="browser-confirm-card">
      <div className="browser-confirm-card__header">
        <Globe size={14} strokeWidth={1.75} className="browser-confirm-card__icon" aria-hidden />
        <span className="browser-confirm-card__headline">{summary.headline}</span>
        <div className="browser-confirm-card__actions">
          <button
            type="button"
            className="browser-confirm-card__action browser-confirm-card__action--allow"
            aria-label="确认"
            onClick={() => onConfirm(true)}
          >
            确认
          </button>
          <button
            type="button"
            className="browser-confirm-card__action browser-confirm-card__action--deny"
            aria-label="拒绝"
            onClick={() => onConfirm(false)}
          >
            拒绝
          </button>
        </div>
      </div>
      <div className="browser-confirm-card__body">
        <div className="browser-confirm-card__field">
          <span className="browser-confirm-card__label">{summary.detailLabel}</span>
          <span
            className={
              summary.detailLabel === 'URL'
                ? 'browser-confirm-card__url'
                : 'browser-confirm-card__value'
            }
            title={summary.detailValue}
          >
            {summary.detailValue}
          </span>
        </div>
        {summary.hint ? <p className="browser-confirm-card__hint">{summary.hint}</p> : null}
      </div>
    </div>
  )
}
