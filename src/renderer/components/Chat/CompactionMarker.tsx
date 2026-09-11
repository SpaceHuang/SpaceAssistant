import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export function CompactionMarker({ count }: { count: number }) {
  const { t } = useTypedTranslation('chat')
  return (
    <div className="chat-compaction-marker" role="status" data-testid="chat-compaction-marker">
      <span>{t('compaction.compressed')}</span>
      {count > 1 ? <span className="chat-compaction-marker-count">{t('compaction.count', { count })}</span> : null}
    </div>
  )
}
