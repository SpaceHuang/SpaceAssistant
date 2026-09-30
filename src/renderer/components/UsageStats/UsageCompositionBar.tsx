import { Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageAttributionCategory, UsageAttributionComposition } from '../../../shared/usageStatsTypes'
import { formatCount, formatPercent, type AbbreviationLocale } from './format'

const CATEGORY_COLORS: Record<UsageAttributionCategory, string> = {
  system: '#5b8ff9',
  tools: '#f6903d',
  userText: '#61bf8f',
  assistantText: '#7f6be0',
  toolResults: '#d65f5f',
  assistantThinking: '#c084fc',
  assistantToolUse: '#e8a33d',
  other: '#8c8c8c'
}

const CATEGORY_ORDER: UsageAttributionCategory[] = [
  'system',
  'tools',
  'userText',
  'assistantText',
  'toolResults',
  'assistantThinking',
  'assistantToolUse',
  'other'
]

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
  const segments = CATEGORY_ORDER.map((key) => ({
    key,
    tokens: composition.categories[key] ?? 0,
    color: CATEGORY_COLORS[key]
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
            style={{ width: `${total > 0 ? (segment.tokens / total) * 100 : 0}%`, background: segment.color, minWidth: segment.tokens > 0 ? 2 : 0 }}
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
