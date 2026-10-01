import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { ScriptCodePreview, ScriptTimeoutMeta } from './ScriptCodePreview'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
  reasonLabel?: string
}

export function ScriptConfirmCard({ record, onConfirm, reasonLabel }: Props) {
  const { t } = useTypedTranslation('chat')

  const code = typeof record.input.code === 'string' ? record.input.code : ''
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const pathHint = typeof record.scriptPathHint === 'string' ? record.scriptPathHint.trim() : ''

  return (
    <div className="write-confirm-card script-confirm-card">
      {reasonLabel ? <p className="write-confirm-card__reason">{reasonLabel}</p> : null}
      <ConfirmCardDecision
        actionSummary={t('confirm.script.actionSummary')}
        allowLabel={t('confirm.script.allow')}
        denyLabel={t('confirm.script.deny')}
        onConfirm={onConfirm}
      >
        <div className="write-confirm-card__subject script-confirm-card__subject">
          {pathHint ? <p className="write-confirm-card__subject-note script-confirm-card__path-hint">{pathHint}</p> : null}
          <div className="write-confirm-card__subject-value write-confirm-card__subject-value--code write-confirm-card__command--code">
            <ScriptCodePreview code={code} />
          </div>
          {timeout !== undefined ? <ScriptTimeoutMeta timeout={timeout} /> : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
