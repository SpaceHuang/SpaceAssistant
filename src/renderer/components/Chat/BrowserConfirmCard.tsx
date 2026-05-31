import { Check, Globe, X } from 'lucide-react'
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
    <div className="write-confirm-card browser-confirm-card">
      <div className="write-confirm-card__header">
        <span className="write-confirm-card__icon-badge" aria-hidden>
          <Globe size={14} strokeWidth={1.75} />
        </span>
        <span className="browser-confirm-card__headline">{summary.headline}</span>
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            aria-label="确认"
            title="确认"
            onClick={() => onConfirm(true)}
          >
            <Check size={16} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            aria-label="拒绝"
            title="拒绝"
            onClick={() => onConfirm(false)}
          >
            <X size={16} strokeWidth={2.25} />
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
