import { useEffect, useState } from 'react'
import { Brain } from 'lucide-react'

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
    <div className="chat-thinking">
      <button
        type="button"
        className="chat-thinking__toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Brain size={14} strokeWidth={1.75} className="chat-thinking__icon" aria-hidden />
        <span>思考</span>
      </button>
      {expanded ? <div className="chat-thinking__body">{content}</div> : null}
    </div>
  )
}
