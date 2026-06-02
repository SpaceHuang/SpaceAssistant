import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'

type Props = {
  /** 一句话说明待确认的操作，例如「写入 config.json」 */
  actionSummary: string
  allowLabel: string
  denyLabel: string
  onConfirm: (approved: boolean) => void
  /** 行数、风险、写入等补充标签，显示在标题旁 */
  badges?: ReactNode
}

export function ConfirmCardDecision({
  actionSummary,
  allowLabel,
  denyLabel,
  onConfirm,
  badges
}: Props) {
  return (
    <div className="write-confirm-card__decision" role="group" aria-label={`确认：${actionSummary}`}>
      <div className="write-confirm-card__decision-head">
        <p className="write-confirm-card__decision-summary">{actionSummary}</p>
        {badges ? <span className="write-confirm-card__decision-badges">{badges}</span> : null}
      </div>
      <div className="write-confirm-card__actions">
        <button
          type="button"
          className="write-confirm-card__action write-confirm-card__action--deny"
          onClick={() => onConfirm(false)}
        >
          <X size={13} strokeWidth={2.25} aria-hidden />
          <span>{denyLabel}</span>
        </button>
        <button
          type="button"
          className="write-confirm-card__action write-confirm-card__action--allow"
          onClick={() => onConfirm(true)}
        >
          <Check size={13} strokeWidth={2.25} aria-hidden />
          <span>{allowLabel}</span>
        </button>
      </div>
    </div>
  )
}
