import { useEffect, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { buildFragmentId } from '../../../shared/chatSearchFragments'
import type { ChatSearchActiveTarget } from '../../services/chatSearchActiveTarget'

type Props = {
  content: string
  /** 思考进行中（流式或未结束）时默认展开 */
  active?: boolean
  messageId?: string
  segmentIndex?: number
  activeSearchTarget?: ChatSearchActiveTarget | null
}

export function ThinkingBlock({
  content,
  active = false,
  messageId,
  segmentIndex = 0,
  activeSearchTarget = null
}: Props) {
  const { t } = useTypedTranslation('chat')
  const [expanded, setExpanded] = useState(active)
  const searchReveal =
    activeSearchTarget?.source.kind === 'thinking' &&
    activeSearchTarget.source.segmentIndex === segmentIndex

  useEffect(() => {
    setExpanded(active)
  }, [active])

  // 搜索 reveal 只覆盖展示状态，不写入用户自己的展开偏好。
  const toggleLabel = expanded || searchReveal ? t('thinking.collapseHint') : t('thinking.expandHint')
  const isExpanded = expanded || searchReveal
  const fragmentId =
    messageId != null ? buildFragmentId(messageId, { kind: 'thinking', segmentIndex }) : undefined

  return (
    <div className={`chat-thinking${isExpanded ? ' chat-thinking--expanded' : ''}`}>
      <button
        type="button"
        className="chat-thinking__toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={isExpanded}
        aria-label={toggleLabel}
      >
        <Brain size={14} strokeWidth={1.75} className="chat-thinking__icon" aria-hidden />
        <span>{t('thinking.label')}</span>
        <ChevronRight size={12} strokeWidth={2} className="chat-thinking__chevron" aria-hidden />
      </button>
      <div className="chat-thinking__panel">
        <div className="chat-thinking__panel-inner">
          <div className="chat-thinking__body" data-search-fragment-id={fragmentId}>
            {content}
          </div>
        </div>
      </div>
    </div>
  )
}
