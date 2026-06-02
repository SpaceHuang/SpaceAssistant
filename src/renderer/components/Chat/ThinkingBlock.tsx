import { useEffect, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'

type Props = {
  content: string
  /** 思考进行中（流式或未结束）时默认展开 */
  active?: boolean
}

export function ThinkingBlock({ content, active = false }: Props) {
  const [expanded, setExpanded] = useState(active)

  useEffect(() => {
    setExpanded(active)
  }, [active])

  return (
    <div className={`chat-thinking${expanded ? ' chat-thinking--expanded' : ''}`}>
      <button
        type="button"
        className="chat-thinking__toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? '收起思考过程' : '展开思考过程'}
      >
        <Brain size={14} strokeWidth={1.75} className="chat-thinking__icon" aria-hidden />
        <span>思考</span>
        <ChevronRight size={12} strokeWidth={2} className="chat-thinking__chevron" aria-hidden />
      </button>
      <div className="chat-thinking__panel">
        <div className="chat-thinking__panel-inner">
          <div className="chat-thinking__body">{content}</div>
        </div>
      </div>
    </div>
  )
}
