import { useMemo } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { summarizeLarkCliConfirmInput } from '../../../shared/larkCliDisplay'
import { ConfirmCardDecision } from './ConfirmCardDecision'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

export function LarkCliConfirmCard({ record, onConfirm }: Props) {
  const summary = useMemo(() => summarizeLarkCliConfirmInput(record.input), [record.input])
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const allowLabel = summary.isWriteOperation ? '确认飞书写入' : '确认飞书命令'

  const denyLabel = summary.isWriteOperation ? '拒绝写入' : '拒绝命令'

  return (
    <div className="write-confirm-card lark-cli-confirm-card">
      <ConfirmCardDecision
        actionSummary={summary.headline}
        allowLabel={allowLabel}
        denyLabel={denyLabel}
        onConfirm={onConfirm}
        badges={
          summary.isWriteOperation ? (
            <span className="write-confirm-card__stat write-confirm-card__stat--write">写入</span>
          ) : undefined
        }
      />
      <div className="write-confirm-card__detail lark-cli-confirm-card__detail">
        <pre className="write-confirm-card__command" title={summary.command}>
          <code className="lark-cli-confirm-card__command-line">{summary.command}</code>
        </pre>
        <p className="write-confirm-card__note lark-cli-confirm-card__hint">{summary.hint}</p>
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
