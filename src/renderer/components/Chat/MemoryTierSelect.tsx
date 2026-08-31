import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export interface MemoryTierOption {
  label: string
  tier: number
}

/**
 * 确认卡片"记忆范围选择器"（P3）：展示可用记忆档位（编号与 IM `记N` 对齐）。
 * 默认选中最窄可用档（"仅此一次"=null）；无档位时组件不渲染，保持旧交互。
 */
export function MemoryTierSelect({
  options,
  value,
  onChange
}: {
  options: MemoryTierOption[]
  value: number | null
  onChange: (tier: number | null) => void
}) {
  const { t } = useTypedTranslation('chat')
  if (!options.length) return null
  return (
    <label className="write-confirm-card__trust-option">
      <span className="write-confirm-card__trust-label">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          aria-label={t('toolCall.confirm.onlyOnce')}
        >
          <option value="">{t('toolCall.confirm.onlyOnce')}</option>
          {options.map((o) => (
            <option key={o.tier} value={o.tier}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  )
}
