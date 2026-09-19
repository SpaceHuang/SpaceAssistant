import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from 'recharts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageDailyPoint } from '../../../shared/usageStatsTypes'
import { formatCount, formatInteger, formatPercent, type AbbreviationLocale } from './format'

type Props = {
  points: UsageDailyPoint[]
}

/**
 * 双轴折线图（§5.3.2 / C15）：左轴 Tokens（输入 / 输出两条线），
 * 右轴输入缓存命中率固定 0–100%（虚线）；命中率无数据的日期断线（null 不连线）。
 */
export function UsageTrendChart({ points }: Props) {
  const { t, i18n } = useTypedTranslation('usageStats')
  // 轴刻度缩写按界面语言进位：英文 K / M，中文万 / 亿
  const abbrevLocale: AbbreviationLocale = String(i18n.language).startsWith('zh') ? 'zh-CN' : 'en-US'
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
        <YAxis
          yAxisId="tokens"
          label={{ value: t('chart.tokensAxis'), angle: -90, position: 'insideLeft' }}
          tickFormatter={(value: number) => formatCount(value, abbrevLocale)}
        />
        <YAxis
          yAxisId="rate"
          orientation="right"
          domain={[0, 1]}
          tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
          tick={{ fontSize: 11 }}
        />
        <RechartsTooltip
          formatter={(value: unknown, name: unknown, item: { dataKey?: unknown }) => {
            const key = String(item?.dataKey ?? '')
            if (key === 'hitRate') return [formatPercent(Number.isFinite(Number(value)) ? Number(value) : null), String(name)]
            return [formatInteger(Number(value)), String(name)]
          }}
        />
        <Legend />
        <Line
          yAxisId="tokens"
          type="monotone"
          dataKey="inputTokens"
          name={t('chart.legendInput')}
          stroke="#5b8ff9"
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="tokens"
          type="monotone"
          dataKey="outputTokens"
          name={t('chart.legendOutput')}
          stroke="#5ad8a6"
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="rate"
          type="monotone"
          dataKey="hitRate"
          name={t('chart.legendHitRate')}
          stroke="#f6bd16"
          strokeDasharray="5 5"
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
