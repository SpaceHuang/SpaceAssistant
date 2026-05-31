type Props = {
  text: string
}

export function SkillHintRow({ text }: Props) {
  return (
    <div className="chat-skill-hint">
      <span className="chat-skill-hint__badge">Skill</span>
      <span className="chat-skill-hint__text">{text}</span>
    </div>
  )
}
