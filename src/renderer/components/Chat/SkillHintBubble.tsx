type Props = {
  hints: string[]
}

export function SkillHintBubble({ hints }: Props) {
  if (hints.length === 0) return null
  return (
    <>
      {hints.map((hint, i) => (
        <div key={`${i}-${hint.slice(0, 24)}`} className="chat-system-track">
          <span className="chat-skill-hint">{hint}</span>
        </div>
      ))}
    </>
  )
}
