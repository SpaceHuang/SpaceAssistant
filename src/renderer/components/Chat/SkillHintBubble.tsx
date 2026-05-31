import type { SkillHintRecord } from '../../../shared/domainTypes'
import { SkillHintRow } from './SkillHintRow'

type Props = {
  hints: SkillHintRecord[]
}

export function SkillHintBubble({ hints }: Props) {
  if (hints.length === 0) return null
  const sorted = [...hints].sort((a, b) => a.shownAt - b.shownAt)
  return (
    <div className="chat-system-track">
      {sorted.map((hint) => (
        <SkillHintRow key={hint.id} text={hint.text} />
      ))}
    </div>
  )
}
