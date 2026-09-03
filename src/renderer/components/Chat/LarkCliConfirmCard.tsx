import { useMemo, useState } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { summarizeLarkCliConfirmInput } from '../../../shared/larkCliDisplay'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { MemoryTierSelect } from './MemoryTierSelect'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: ToolConfirmHandler
}

export function LarkCliConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const [memoryTier, setMemoryTier] = useState<number | null>(null)
  const summary = useMemo(() => summarizeLarkCliConfirmInput(record.input), [record.input])
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const allowLabel = summary.isWriteOperation ? t('confirm.lark.allowWrite') : t('confirm.lark.allowCommand')
  const denyLabel = summary.isWriteOperation ? t('confirm.lark.denyWrite') : t('confirm.lark.denyCommand')
  const memoryTierOptions = (record.memoryTiers ?? []).map((mt, i) => ({ label: mt.label, tier: i + 1 }))
  const handleConfirm: ToolConfirmHandler = (approved, options) => {
    const sel = memoryTier
    const selected = approved && sel != null ? record.memoryTiers?.[sel - 1]?.key : undefined
    if (selected) {
      onConfirm(approved, { ...options, memoryTier: selected })
      return
    }
    if (options && Object.keys(options).length > 0) {
      onConfirm(approved, options)
      return
    }
    onConfirm(approved)
  }

  return (
    <div className="write-confirm-card lark-cli-confirm-card">
      <ConfirmCardDecision
        actionSummary={summary.headline}
        allowLabel={allowLabel}
        denyLabel={denyLabel}
        onConfirm={handleConfirm}
        badges={
          summary.isWriteOperation ? (
            <span className="write-confirm-card__stat write-confirm-card__stat--write">{t('confirm.lark.writeBadge')}</span>
          ) : undefined
        }
      >
        <div className="write-confirm-card__subject lark-cli-confirm-card__subject">
          <pre className="write-confirm-card__subject-value write-confirm-card__subject-value--code" title={summary.command}>
            <code className="lark-cli-confirm-card__command-line">{summary.command}</code>
          </pre>
          <p className="write-confirm-card__subject-note lark-cli-confirm-card__hint">{summary.hint}</p>
          {timeout !== undefined ? (
            <div className="lark-cli-confirm-card__meta">
              <span className="lark-cli-confirm-card__meta-item">
                <span className="lark-cli-confirm-card__meta-key">timeout</span>
                <span className="lark-cli-confirm-card__meta-value">{timeout}s</span>
              </span>
            </div>
          ) : null}
          <MemoryTierSelect options={memoryTierOptions} value={memoryTier} onChange={setMemoryTier} />
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
