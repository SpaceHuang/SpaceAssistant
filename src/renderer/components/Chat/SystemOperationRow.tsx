import { useState } from 'react'
import { Check, ChevronDown, CircleX, LoaderCircle, SkipForward } from 'lucide-react'
import type { SystemOperationRecord } from '../../../shared/domainTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export function SystemOperationRow({ operation }: { operation: SystemOperationRecord }) {
  const { t } = useTypedTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const label = operation.status === 'running'
    ? t('systemOperation.running')
    : operation.status === 'succeeded'
      ? operation.reason === 'REPAIR_ORIGINAL_WINDOW'
        ? t('systemOperation.repairOriginalSucceeded')
        : operation.reason === 'REPAIR_NEW_SPLIT'
          ? t('systemOperation.repairNewSplitSucceeded')
          : operation.beforePercent != null && operation.afterPercent != null
        ? t('systemOperation.succeeded', { before: operation.beforePercent, after: operation.afterPercent })
        : t('systemOperation.title')
      : operation.status === 'failed'
        ? t('systemOperation.failed')
        : operation.status === 'cancelled'
          ? t('systemOperation.cancelled')
          : operation.reason === 'UNCOMPRESSIBLE'
            ? t('systemOperation.skippedUncompressible')
            : operation.reason === 'LATE_DISCARDED'
              ? t('systemOperation.skippedDiscarded')
              : t('systemOperation.skippedNoGain')
  const reason = operation.reason === 'SUMMARY_TIMEOUT'
    ? t('systemOperation.reasonTimeout')
    : operation.reason === 'SUMMARY_INVALID'
      ? t('systemOperation.reasonInvalid')
      : operation.reason === 'SUMMARY_UNAVAILABLE'
        ? t('systemOperation.reasonUnavailable')
        : operation.reason === 'SUMMARY_FAILED'
          ? t('systemOperation.reasonFailed')
          : operation.reason === 'REPAIR_FALLBACK_FULL_EXPAND'
            ? t('systemOperation.repairFallbackFullExpand')
          : undefined
  const Icon = operation.status === 'running' ? LoaderCircle : operation.status === 'succeeded' ? Check : operation.status === 'skipped' ? SkipForward : CircleX

  return (
    <div className={`system-operation-row system-operation-row--${operation.status}`} role="status" aria-live={operation.status === 'running' ? 'polite' : undefined}>
      <Icon className={`system-operation-row__icon${operation.status === 'running' ? ' system-operation-row__icon--spin' : ''}`} size={15} aria-hidden="true" />
      <span className="system-operation-row__label">{label}</span>
      {reason ? (
        <button
          type="button"
          className="system-operation-row__reason-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('systemOperation.hideReason') : t('systemOperation.showReason')}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      ) : null}
      {reason && expanded ? <p className="system-operation-row__reason">{reason}</p> : null}
    </div>
  )
}
