import { Card, Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageAttributionComposition, UsageToolAttributionBreakdown } from '../../../shared/usageStatsTypes'
import { formatPercent } from './format'

type Props = {
  composition: UsageAttributionComposition
  toolBreakdown: UsageToolAttributionBreakdown
}

/**
 * 洞察卡片（视图④，AD22）：3 条规则硬编码、相对判据、不做配置化（§6.6.4）。
 * 每条同时给「数字」与「动作建议」；数据不足时对应卡片整张不渲染（I5）。
 */
export function UsageInsightCards({ composition, toolBreakdown }: Props) {
  const { t } = useTypedTranslation('usageStats')
  const cards: Array<{ testId: string; title: string; action: string }> = []

  // 规则 1（SRC-B4）：未使用工具占工具声明总成本 > 一半
  if (toolBreakdown.totalDeclaredChars > 0 && toolBreakdown.unusedDeclaredChars / toolBreakdown.totalDeclaredChars > 0.5) {
    cards.push({
      testId: 'usage-insight-unused-tools',
      title: t('insight.unusedTools.title', {
        count: toolBreakdown.unused.length,
        percent: formatPercent(toolBreakdown.unusedDeclaredChars / toolBreakdown.totalDeclaredChars)
      }),
      action: t('insight.unusedTools.action')
    })
  }

  // 规则 2（SRC-A3）：固定成本占比 < 10% → 优化重心在增量侧
  const fixedTokens = (composition.categories.system ?? 0) + (composition.categories.tools ?? 0)
  if (composition.attributableInputTokens > 0 && fixedTokens / composition.attributableInputTokens < 0.1) {
    cards.push({
      testId: 'usage-insight-fixed-cost',
      title: t('insight.fixedCost.title', {
        percent: formatPercent(fixedTokens / composition.attributableInputTokens)
      }),
      action: t('insight.fixedCost.action')
    })
  }

  // 规则 3（SRC-C1）：Top 3 工具的返回体量占全部工具返回 > 一半
  const resultChars = toolBreakdown.used
    .map((entry) => entry.resultChars ?? 0)
    .sort((a, b) => b - a)
  const totalResultChars = resultChars.reduce((a, b) => a + b, 0)
  if (totalResultChars > 0 && resultChars.length >= 3) {
    const top3 = resultChars.slice(0, 3).reduce((a, b) => a + b, 0)
    if (top3 / totalResultChars > 0.5) {
      cards.push({
        testId: 'usage-insight-top-results',
        title: t('insight.topToolResults.title', { percent: formatPercent(top3 / totalResultChars) }),
        action: t('insight.topToolResults.action')
      })
    }
  }

  if (cards.length === 0) return null

  return (
    <div data-testid="usage-insight-cards">
      <Typography.Text type="secondary">{t('insight.title')}</Typography.Text>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
        {cards.map((card) => (
          <Card key={card.testId} size="small" style={{ minWidth: 280, flex: '1 1 280px' }} data-testid={card.testId}>
            <Typography.Text strong>{card.title}</Typography.Text>
            <div>
              <Typography.Text type="secondary">{card.action}</Typography.Text>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
