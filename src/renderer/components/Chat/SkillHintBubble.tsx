export type SkillHint = { text: string; timestamp: number }

type Props = {
  hints: SkillHint[]
}

export function SkillHintBubble({ hints }: Props) {
  if (hints.length === 0) return null
  return (
    <>
      {hints.map((hint, i) => (
        <div key={`${i}-${hint.text.slice(0, 24)}`} className="chat-system-track">
          <span className="chat-skill-hint">{hint.text}</span>
        </div>
      ))}
    </>
  )
}
