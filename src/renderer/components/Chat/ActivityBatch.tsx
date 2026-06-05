import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Pin } from 'lucide-react'
import type { AssistantActivityItem } from '../../../shared/assistantActivityTimeline'
import { ACTIVITY_BATCH_AUTO_COLLAPSE_DELAY_MS } from '../../../shared/activityBatchGrouping'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type ActivityBatchSummary = {
  icon: ReactNode
  label: string
}

type Props = {
  items: AssistantActivityItem[]
  isActive: boolean
  summary: ActivityBatchSummary
  renderItem: (item: AssistantActivityItem, index: number) => ReactNode
}

export function ActivityBatch({ items, isActive, summary, renderItem }: Props) {
  const { t } = useTypedTranslation('chat')
  const [expanded, setExpanded] = useState(isActive)
  const [pinned, setPinned] = useState(false)
  const wasActiveRef = useRef(isActive)

  useEffect(() => {
    if (isActive) {
      wasActiveRef.current = true
      setExpanded(true)
      return
    }
    if (pinned) return

    if (wasActiveRef.current) {
      wasActiveRef.current = false
      const timer = setTimeout(() => setExpanded(false), ACTIVITY_BATCH_AUTO_COLLAPSE_DELAY_MS)
      return () => clearTimeout(timer)
    }

    setExpanded(false)
  }, [isActive, pinned])

  const toggleExpanded = () => setExpanded((v) => !v)
  const togglePin = (event: React.MouseEvent) => {
    event.stopPropagation()
    setPinned((v) => !v)
  }

  const toggleLabel = expanded ? t('batch.collapse') : t('batch.expand')

  return (
    <div className={`activity-batch${expanded ? ' activity-batch--expanded' : ''}`}>
      <div className="activity-batch__header-row">
        <button
          type="button"
          className="activity-batch__header"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          aria-label={toggleLabel}
        >
          <span className="activity-batch__icon" aria-hidden>
            {summary.icon}
          </span>
          <span className="activity-batch__label">{summary.label}</span>
          <ChevronRight size={12} strokeWidth={2} className="activity-batch__chevron" aria-hidden />
        </button>
        <button
          type="button"
          className={`activity-batch__pin${pinned ? ' activity-batch__pin--active' : ''}`}
          onClick={togglePin}
          aria-label={pinned ? t('batch.unpin') : t('batch.pin')}
          aria-pressed={pinned}
        >
          <Pin size={12} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="activity-batch__body-panel">
        <div className="activity-batch__body-panel-inner">
          <div className="activity-batch__body">
            {items.map((item, index) => (
              <div key={`batch-item-${index}`} className="activity-batch__item">
                {renderItem(item, index)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
