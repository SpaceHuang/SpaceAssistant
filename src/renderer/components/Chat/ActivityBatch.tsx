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
  /** 批次内含待确认工具时保持展开，避免确认卡片被折叠隐藏 */
  keepExpanded?: boolean
  /** 搜索命中位于本批次时强制展开（不改 pin / 用户偏好） */
  searchReveal?: boolean
  summary: ActivityBatchSummary
  renderItem: (item: AssistantActivityItem, index: number) => ReactNode
}

export function ActivityBatch({
  items,
  isActive,
  keepExpanded = false,
  searchReveal = false,
  summary,
  renderItem
}: Props) {
  const { t } = useTypedTranslation('chat')
  const [expanded, setExpanded] = useState(isActive)
  const [pinned, setPinned] = useState(false)
  const wasActiveRef = useRef(isActive)
  const userExpandedBeforeSearchRef = useRef<boolean | null>(null)

  useEffect(() => {
    if (searchReveal) {
      if (userExpandedBeforeSearchRef.current == null) {
        userExpandedBeforeSearchRef.current = expanded
      }
      setExpanded(true)
      return
    }
    if (userExpandedBeforeSearchRef.current != null) {
      setExpanded(userExpandedBeforeSearchRef.current)
      userExpandedBeforeSearchRef.current = null
    }
  }, [searchReveal]) // eslint-disable-line react-hooks/exhaustive-deps -- 仅在搜索覆盖进出时恢复

  useEffect(() => {
    if (searchReveal) return
    if (keepExpanded) {
      setExpanded(true)
      return
    }
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
  }, [isActive, pinned, keepExpanded, searchReveal])

  const toggleExpanded = () => setExpanded((v) => !v)
  const togglePin = (event: React.MouseEvent) => {
    event.stopPropagation()
    setPinned((v) => !v)
  }

  const effectivelyExpanded = expanded || searchReveal
  const toggleLabel = effectivelyExpanded ? t('batch.collapse') : t('batch.expand')

  return (
    <div
      className={[
        'activity-batch',
        effectivelyExpanded ? 'activity-batch--expanded' : '',
        isActive ? 'activity-batch--active' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="activity-batch__header-row">
        <button
          type="button"
          className="activity-batch__header"
          onClick={toggleExpanded}
          aria-expanded={effectivelyExpanded}
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
            {effectivelyExpanded
              ? items.map((item, index) => (
                  <div key={`batch-item-${index}`} className="activity-batch__item">
                    {renderItem(item, index)}
                  </div>
                ))
              : null}
          </div>
        </div>
      </div>
    </div>
  )
}
