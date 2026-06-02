import { useMemo } from 'react'
import { Check, MessagesSquare, X } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { summarizeLarkCliConfirmInput } from '../../../shared/larkCliDisplay'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

export function LarkCliConfirmCard({ record, onConfirm }: Props) {
  const summary = useMemo(() => summarizeLarkCliConfirmInput(record.input), [record.input])
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const allowLabel = summary.isWriteOperation ? '确认飞书写入' : '确认飞书命令'

  return (
    <div className="write-confirm-card lark-cli-confirm-card">
      <div className="write-confirm-card__header">
        <span className="write-confirm-card__icon-badge" aria-hidden>
          <MessagesSquare size={14} strokeWidth={1.75} className="write-confirm-card__file-icon" />
        </span>
        <span className="lark-cli-confirm-card__title">{summary.headline}</span>
        {summary.isWriteOperation ? (
          <span className="write-confirm-card__stat write-confirm-card__stat--write">写入</span>
        ) : null}
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            aria-label={allowLabel}
            title={allowLabel}
            onClick={() => onConfirm(true)}
          >
            <Check size={16} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            aria-label="拒绝飞书命令"
            title="拒绝飞书命令"
            onClick={() => onConfirm(false)}
          >
            <X size={16} strokeWidth={2.25} />
          </button>
        </div>
      </div>
      <div className="write-confirm-card__body lark-cli-confirm-card__body">
        <pre className="lark-cli-confirm-card__command" title={summary.command}>
          <code className="lark-cli-confirm-card__command-line">{summary.command}</code>
        </pre>
        <p className="lark-cli-confirm-card__hint">{summary.hint}</p>
        {timeout !== undefined ? (
          <div className="lark-cli-confirm-card__meta">
            <span className="lark-cli-confirm-card__meta-item">
              <span className="lark-cli-confirm-card__meta-key">timeout</span>
              <span className="lark-cli-confirm-card__meta-value">{timeout}s</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
