import { useMemo } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { ShikiHighlightedCode } from './ShikiHighlightedCode'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

const PREVIEW_MAX_LINES = 120

function previewCode(code: string): string {
  if (!code) return '(空)'
  const lines = code.split('\n')
  if (lines.length <= PREVIEW_MAX_LINES) return code
  return [...lines.slice(0, PREVIEW_MAX_LINES), '…'].join('\n')
}

export function ScriptConfirmCard({ record, onConfirm }: Props) {
  const code = typeof record.input.code === 'string' ? record.input.code : ''
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const displayCode = useMemo(() => previewCode(code), [code])

  return (
    <div className="write-confirm-card script-confirm-card">
      <ConfirmCardDecision
        actionSummary="运行 Python 脚本"
        allowLabel="确认运行"
        denyLabel="拒绝运行"
        onConfirm={onConfirm}
      />
      <div className="write-confirm-card__detail script-confirm-card__detail">
        <div className="write-confirm-card__command write-confirm-card__command--code">
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
    </div>
  )
}
