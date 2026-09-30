import { Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageAttributionComposition } from '../../../shared/usageStatsTypes'
import { formatCount, formatPercent, type AbbreviationLocale } from './format'
import { ATTRIBUTION_CATEGORY_COLORS, ATTRIBUTION_CATEGORY_ORDER } from './categories'

type Props = {
  composition: UsageAttributionComposition
}

/**
 * 视图① 构成快照（AD19）：横向 100% 堆叠条形，不做饼图。
 * 数值为归一化 token（估算层给结构、精确层给总量），整块带估算标注（AT2/AT10）。
 */
export function UsageCompositionBar({ composition }: Props) {
  const { t, i18n } = useTypedTranslation('usageStats')
  const abbrevLocale: AbbreviationLocale = String(i18n.language).startsWith('zh') ? 'zh-CN' : 'en-US'
  const total = composition.attributableInputTokens
  const segments = ATTRIBUTION_CATEGORY_ORDER.map((key) => ({
    key,
    tokens: composition.categories[key] ?? 0,
    color: ATTRIBUTION_CATEGORY_COLORS[key]
  })).filter((s) => s.tokens > 0)

  return (
    <div data-testid="usage-composition-bar" title={composition.estimatorVersion}>
      <Typography.Text type="secondary">
        {t('composition.snapshot')}（{t('composition.snapshotHint')} · {t('composition.estimated')}）
      </Typography.Text>
      <div style={{ display: 'flex', height: 28, borderRadius: 4, overflow: 'hidden', marginTop: 8 }}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            data-testid="usage-composition-segment"
            title={`${t(`composition.categories.${segment.key}`)} · ${formatCount(segment.tokens, abbrevLocale)}（${formatPercent(total > 0 ? segment.tokens / total : null)}）`}
            style={{ width: `${total > 0 ? (segment.tokens / total) * 100 : 0}%`, background: segment.color }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
        {segments.map((segment) => (
          <Typography.Text key={segment.key} style={{ fontSize: 12 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: segment.color, marginRight: 4 }} />
            {t(`composition.categories.${segment.key}`)} {formatCount(segment.tokens, abbrevLocale)}
          </Typography.Text>
        ))}
      </div>
    </div>
  )
}
