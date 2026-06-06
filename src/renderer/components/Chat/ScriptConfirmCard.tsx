import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { ScriptCodePreview, ScriptTimeoutMeta } from './ScriptCodePreview'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

export function ScriptConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')

  const code = typeof record.input.code === 'string' ? record.input.code : ''
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined

  return (
    <div className="write-confirm-card script-confirm-card">
      <ConfirmCardDecision
        actionSummary={t('confirm.script.actionSummary')}
        allowLabel={t('confirm.script.allow')}
        denyLabel={t('confirm.script.deny')}
        onConfirm={onConfirm}
      >
        <div className="write-confirm-card__subject script-confirm-card__subject">
          <div className="write-confirm-card__subject-value write-confirm-card__subject-value--code write-confirm-card__command--code">
            <ScriptCodePreview code={code} />
          </div>
          {timeout !== undefined ? <ScriptTimeoutMeta timeout={timeout} /> : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
