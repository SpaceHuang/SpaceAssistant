import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfirmCardCollapsible } from './ConfirmCardCollapsible'
import { ConfirmCardDecision } from './ConfirmCardDecision'

type Props = {
  record: ToolCallRecord
  onConfirm: ToolConfirmHandler
}

/**
 * toolkit.call 确认卡（需求 §5 确认卡片）：复刻 McpConfirmCard 的「网关 + 子实体」先例——
 * 展示能力 id 与参数摘要；能力 summary 由确认事实链（extractor 摘要）提供。
 */
export function ToolkitConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const id = typeof record.input?.id === 'string' ? record.input.id : ''
  const params = record.input?.params
  const paramEntries = params && typeof params === 'object' ? Object.entries(params as Record<string, unknown>) : []

  return (
    <div className="write-confirm-card">
      <ConfirmCardDecision
        actionSummary={t('confirm.toolkit.title')}
        allowLabel={t('confirm.toolkit.allow')}
        denyLabel={t('confirm.toolkit.deny')}
        onConfirm={(approved) => onConfirm(approved)}
        badges={<span>{t('confirm.toolkit.capability', { id: id || '…' })}</span>}
      >
        <div className="write-confirm-card__subject">
          <p className="write-confirm-card__subject-note">{t('confirm.toolkit.riskHint')}</p>
          <p className="write-confirm-card__subject-note">{t('confirm.toolkit.argsLabel')}</p>
          <ConfirmCardCollapsible lineCount={paramEntries.length}>
            {paramEntries.length === 0 ? (
              <p className="write-confirm-card__subject-note">{t('confirm.toolkit.emptyArgs')}</p>
            ) : (
              <pre className="write-confirm-card__subject-value write-confirm-card__subject-value--code mcp-confirm-card__args">
                {JSON.stringify(params, null, 2)}
              </pre>
            )}
          </ConfirmCardCollapsible>
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
