import { useState } from 'react'
import { Radio, Typography } from 'antd'
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageAttributionDailyPoint } from '../../../shared/usageStatsTypes'
import { formatCount, formatInteger, formatPercent, type AbbreviationLocale } from './format'
import { ATTRIBUTION_CATEGORY_COLORS, ATTRIBUTION_CATEGORY_ORDER } from './categories'

type Props = {
  points: UsageAttributionDailyPoint[]
}

type ScaleMode = 'absolute' | 'percent'

/**
 * 视图② 构成漂移（AD20）：堆叠面积图，Y 轴默认绝对量（信息量更多、服务「找浪费」），占比可切换。
 */
export function UsageCompositionArea({ points }: Props) {
  const { t, i18n } = useTypedTranslation('usageStats')
  const [scale, setScale] = useState<ScaleMode>('absolute')
  const abbrevLocale: AbbreviationLocale = String(i18n.language).startsWith('zh') ? 'zh-CN' : 'en-US'

  const data = points.map((point) => {
    const total = point.attributableInputTokens
    const row: Record<string, string | number> = { day: point.day }
    for (const key of ATTRIBUTION_CATEGORY_ORDER) {
      const tokens = point.categories[key] ?? 0
      row[key] = scale === 'percent' && total > 0 ? (tokens / total) * 100 : tokens
    }
    return row
  })
  const hasAnyData = points.some((point) => point.attributableInputTokens > 0)

  return (
    <div data-testid="usage-composition-area">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text type="secondary">{t('composition.drift')}</Typography.Text>
        <Radio.Group
          size="small"
          value={scale}
          onChange={(e) => setScale(e.target.value as ScaleMode)}
          options={[
            { value: 'absolute', label: t('composition.driftScale.absolute') },
            { value: 'percent', label: t('composition.driftScale.percent') }
          ]}
          optionType="button"
        />
      </div>
      {hasAnyData ? (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis
              tickFormatter={(value: number) =>
                scale === 'percent' ? `${Math.round(value)}%` : formatCount(value, abbrevLocale)
              }
              tick={{ fontSize: 11 }}
            />
            <RechartsTooltip
              formatter={(value: unknown, name: unknown) => [
                scale === 'percent' ? formatPercent(Number(value) / 100) : formatInteger(Number(value)),
                String(name)
              ]}
            />
            <Legend />
            {ATTRIBUTION_CATEGORY_ORDER.map((key) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                stackId="composition"
                name={t(`composition.categories.${key}`)}
                stroke={ATTRIBUTION_CATEGORY_COLORS[key]}
                fill={ATTRIBUTION_CATEGORY_COLORS[key]}
                fillOpacity={0.6}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          {t('chart.empty')}
        </Typography.Paragraph>
      )}
    </div>
  )
}
