import { useMemo } from 'react'
import { Check, FileCode, X } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
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
      <div className="write-confirm-card__header">
        <span className="write-confirm-card__icon-badge" aria-hidden>
          <FileCode size={14} strokeWidth={1.75} className="write-confirm-card__file-icon" />
        </span>
        <span className="script-confirm-card__title">Python 脚本</span>
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            aria-label="确认运行脚本"
            title="确认运行脚本"
            onClick={() => onConfirm(true)}
          >
            <Check size={16} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            aria-label="拒绝运行脚本"
            title="拒绝运行脚本"
            onClick={() => onConfirm(false)}
          >
            <X size={16} strokeWidth={2.25} />
          </button>
        </div>
      </div>
      <div className="write-confirm-card__body script-confirm-card__body">
        <ShikiHighlightedCode
          code={displayCode}
          language="python"
          className="script-confirm-card__code script-confirm-card__code--highlighted"
          fallbackClassName="script-confirm-card__code script-confirm-card__code--plain"
        />
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
