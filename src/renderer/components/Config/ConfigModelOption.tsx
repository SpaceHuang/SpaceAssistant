import type { ModelEntry } from '../../../shared/domainTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { sortModelsFastFirst } from '../../../shared/llmModelConfig'

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return String(n)
}

export function formatModelMeta(m: ModelEntry, t: ReturnType<typeof useTypedTranslation<'config'>>['t']): string {
  return `${t('models.metaContext')} ${formatNumber(m.maximumContext)} · ${t('models.metaOutput')} ${formatNumber(m.maxTokens)}`
}

function FastBadgeIcon() {
  return (
    <svg className="config-model-badge__icon" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  )
}

function VisionBadgeIcon() {
  return (
    <svg className="config-model-badge__icon" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6"
      />
    </svg>
  )
}

export function ConfigModelFastBadge() {
  const { t } = useTypedTranslation('config')
  return (
    <span className="config-model-badge config-model-badge--fast">
      <FastBadgeIcon />
      <span>{t('models.fastBadge')}</span>
    </span>
  )
}

export function ConfigModelVisionBadge() {
  const { t } = useTypedTranslation('config')
  return (
    <span className="config-model-badge config-model-badge--vision">
      <VisionBadgeIcon />
      <span>{t('models.visionBadge')}</span>
    </span>
  )
}

export function ConfigModelBadges({ m }: { m: ModelEntry }) {
  return (
    <span className="config-model-badges">
      {m.isFast ? <ConfigModelFastBadge /> : null}
      {m.isVision ? <ConfigModelVisionBadge /> : null}
    </span>
  )
}

type ConfigModelOptionContentProps = {
  m: ModelEntry
  selected?: boolean
  /** 仅名称 + 标签，11px，无上下文元信息 */
  compact?: boolean
}

export function ConfigModelOptionContent({ m, selected, compact }: ConfigModelOptionContentProps) {
  const { t } = useTypedTranslation('config')

  return (
    <div
      className={[
        'config-model-option',
        selected ? 'config-model-option--selected' : '',
        compact ? 'config-model-option--compact' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="config-model-option__row">
        <span className="config-model-option__name">{m.name}</span>
        <ConfigModelBadges m={m} />
      </div>
      {!compact ? (
        <div className="config-model-option__meta">
          {t('models.metaContext')} {formatNumber(m.maximumContext)} · {t('models.metaOutput')}{' '}
          {formatNumber(m.maxTokens)}
        </div>
      ) : null}
    </div>
  )
}

/** 设置页优选下拉收起态：名称 + 规格，不重复展示能力标签（分组标题已说明用途） */
export function ConfigModelSelectValuePreferred({ m }: { m: ModelEntry }) {
  const { t } = useTypedTranslation('config')

  return (
    <div className="config-model-select-value config-model-select-value--preferred">
      <span className="config-model-select-value__name" title={m.name}>
        {m.name}
      </span>
      <span className="config-model-select-value__meta">
        {t('models.metaContext')} {formatNumber(m.maximumContext)} · {t('models.metaOutput')}{' '}
        {formatNumber(m.maxTokens)}
      </span>
    </div>
  )
}

/** Select 收起态：双行信息，与下拉选项区分 */
export function ConfigModelSelectValue({ m }: { m: ModelEntry }) {
  const { t } = useTypedTranslation('config')

  return (
    <div className="config-model-select-value">
      <div className="config-model-select-value__primary">
        <span className="config-model-select-value__name" title={m.name}>
          {m.name}
        </span>
        <ConfigModelBadges m={m} />
      </div>
      <span className="config-model-select-value__meta">
        {t('models.metaContext')} {formatNumber(m.maximumContext)} · {t('models.metaOutput')}{' '}
        {formatNumber(m.maxTokens)}
      </span>
    </div>
  )
}

export { sortModelsFastFirst }
