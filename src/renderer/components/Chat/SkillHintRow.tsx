import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  text: string
  category?: 'skill' | 'status'
  status?: 'continuation-started'
}

export function SkillHintRow({ text, category = 'skill', status }: Props) {
  const { t } = useTypedTranslation('chat')
  const displayText = status === 'continuation-started' ? t('chatView.continuationStarted') : text
  return (
    <div className="chat-skill-hint">
      <span className="chat-skill-hint__badge">{category === 'status' ? t('chatView.statusLabel') : 'Skill'}</span>
      <span className="chat-skill-hint__text">{displayText}</span>
    </div>
  )
}
