import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { sanitizeCapabilityParamsForDisplay } from '../../../shared/capabilityParamSanitize'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfirmCardCollapsible } from './ConfirmCardCollapsible'
import { ConfirmCardDecision } from './ConfirmCardDecision'

type Props = {
  record: ToolCallRecord
  onConfirm: ToolConfirmHandler
}

/**
 * toolkit.call 确认卡（需求 §5 确认卡片）：复刻 McpConfirmCard 的「网关 + 子实体」先例——
 * 展示能力 id 与参数摘要；凭据类参数值展示前归并为存在性布尔（评审 B1）。
 */
export function ToolkitConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const id = typeof record.input?.id === 'string' ? record.input.id : ''
  const params = record.input?.params
  const displayParams = sanitizeCapabilityParamsForDisplay(params)
  const paramEntries =
    displayParams && typeof displayParams === 'object' ? Object.entries(displayParams as Record<string, unknown>) : []

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
                {JSON.stringify(displayParams, null, 2)}
              </pre>
            )}
          </ConfirmCardCollapsible>
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
