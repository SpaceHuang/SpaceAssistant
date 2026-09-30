import { Alert, Spin, Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type {
  UsageAttributionComposition,
  UsageAttributionDailyPoint,
  UsageAttributionOutputSplit,
  UsageToolAttributionBreakdown
} from '../../../shared/usageStatsTypes'
import { formatCount, formatPercent, type AbbreviationLocale } from './format'
import { UsageBreakdownTable } from './UsageBreakdownTable'
import { UsageCompositionArea } from './UsageCompositionArea'
import { UsageCompositionBar } from './UsageCompositionBar'
import { UsageInsightCards } from './UsageInsightCards'

type Props = {
  composition: UsageAttributionComposition | null
  daily: UsageAttributionDailyPoint[]
  outputSplit: UsageAttributionOutputSplit | null
  toolBreakdown: UsageToolAttributionBreakdown | null
  loading: boolean
  /** 归因查询失败（区别于「无归因数据」——失败时不得展示「早于归因能力上线」的错误事实，评审 P1-2） */
  loadError?: boolean
}

/**
 * 「成本构成」Tab（AD13）：与「总览」共用筛选状态，本组件只承接数据。
 * 覆盖率是一等展示数字（I7）；无归因数据时空态 + 原因说明，不补 0、不报错（AT16/I5）。
 */
export function UsageCompositionPanel({ composition, daily, outputSplit, toolBreakdown, loading, loadError }: Props) {
  const { t, i18n } = useTypedTranslation('usageStats')
  const abbrevLocale: AbbreviationLocale = String(i18n.language).startsWith('zh') ? 'zh-CN' : 'en-US'

  if (loading && composition === null) {
    return (
      <Spin spinning>
        <div style={{ minHeight: 200 }} />
      </Spin>
    )
  }

  const hasAttributableData = composition !== null && composition.attributableInputTokens > 0
  if (!hasAttributableData) {
    // 查询失败：中性错误文案（可重试的临时态），不冒充「早于归因能力上线」的数据事实
    if (loadError) {
      return (
        <div data-testid="usage-attribution-load-error">
          <Alert type="error" showIcon message={t('loadFailed')} />
        </div>
      )
    }
    return (
      <div data-testid="usage-attribution-empty">
        <Alert
          type="info"
          showIcon
          message={t('composition.emptyTitle')}
          description={t('composition.emptyReason')}
        />
      </div>
    )
  }

  const coverage = composition!.attributionCoverage
  const unattributedTokens = composition!.totalInputTokens - composition!.attributableInputTokens
  const output = outputSplit
  const breakdown = toolBreakdown

  return (
    <Spin spinning={loading}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {coverage !== null && coverage < 1 && (
          <Alert
            type="info"
            showIcon
            data-testid="usage-attribution-coverage"
            message={t('composition.coverage', { percent: formatPercent(coverage) })}
            description={t('composition.unattributed', { tokens: formatCount(unattributedTokens, abbrevLocale) })}
          />
        )}
        {loadError && (
          <Alert
            type="warning"
            showIcon
            data-testid="usage-attribution-partial-error"
            message={t('loadFailed')}
          />
        )}
        {composition && <UsageInsightCards composition={composition} toolBreakdown={breakdown ?? { used: [], unused: [], totalDeclaredChars: 0, unusedDeclaredChars: 0 }} />}
        {composition && <UsageCompositionBar composition={composition} />}
        {output !== null && output.attributableOutputTokens > 0 && (
          <div data-testid="usage-composition-output">
            <Typography.Text type="secondary">
              {t('composition.output')}（{t('composition.outputHint')}）
            </Typography.Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
              {(
                [
                  ['thinking', output.categories.thinking],
                  ['text', output.categories.text],
                  ['toolUseArgs', output.categories.toolUseArgs]
                ] as Array<['thinking' | 'text' | 'toolUseArgs', number]>
              ).map(([key, tokens]) => (
                <Typography.Text key={key} style={{ fontSize: 12 }}>
                  {t(`composition.outputCategories.${key}`)} {formatCount(tokens, abbrevLocale)}
                </Typography.Text>
              ))}
            </div>
          </div>
        )}
        <UsageCompositionArea points={daily} />
        {breakdown !== null && <UsageBreakdownTable breakdown={breakdown} />}
      </div>
    </Spin>
  )
}
