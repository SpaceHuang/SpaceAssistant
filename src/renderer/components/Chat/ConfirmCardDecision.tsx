import type { ReactNode } from 'react'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  /** 操作类型说明，例如「打开网页」「写入 notes.txt」 */
  actionSummary: string
  allowLabel: string
  denyLabel: string
  onConfirm: (approved: boolean) => void
  /** 行数、风险、写入等补充标签 */
  badges?: ReactNode
  /** 待确认的主体内容（URL、命令、diff 等），渲染在说明与按钮之间 */
  children?: ReactNode
}

export function ConfirmCardDecision({
  actionSummary,
  allowLabel,
  denyLabel,
  onConfirm,
  badges,
  children
}: Props) {
  const { t } = useTypedTranslation('chat')

  return (
    <>
      <div className="write-confirm-card__intro">
        <p className="write-confirm-card__intro-label">{actionSummary}</p>
        {badges ? <span className="write-confirm-card__intro-badges">{badges}</span> : null}
      </div>
      {children}
      <div
        className="write-confirm-card__footer"
        role="group"
        aria-label={t('confirm.decisionAriaLabel', { action: actionSummary })}
      >
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            onClick={() => onConfirm(false)}
          >
            {denyLabel}
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            onClick={() => onConfirm(true)}
          >
            {allowLabel}
          </button>
        </div>
      </div>
    </>
  )
}
