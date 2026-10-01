import { useMemo, useState } from 'react'
import { Select, Table, Typography } from 'antd'
import './usageAttribution.css'
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageAttributionSummary } from '../../../shared/usageStatsTypes'

const COLORS = ['#3978c5', '#6da889', '#d39a45', '#9a78bb', '#d16f78', '#48a6a8', '#8795a6']
const number = (value: number, locale: string) => value.toLocaleString(locale)

type Props = { data: UsageAttributionSummary | null; loading: boolean; locale: string }

export function UsageAttributionView({ data, loading, locale }: Props) {
  const { t } = useTypedTranslation('usageStats')
  const [selectedVersion, setSelectedVersion] = useState<string>()
  const versions = data?.byEstimatorVersion ?? []
  const version = versions.find((item) => item.estimatorVersion === selectedVersion) ?? versions.at(-1)
  const chartData = useMemo(() => {
    if (!version) return []
    return (data?.dailyByEstimatorVersion ?? []).filter((point) => point.estimatorVersion === version.estimatorVersion).map((point) => ({
      day: point.day,
      [t('attribution.system')]: point.composition.system,
      [t('attribution.tools')]: point.composition.tools,
      ...Object.fromEntries(Object.entries(point.composition.messageBlocks).map(([key, value]) => [key, value]))
    }))
  }, [data, version, t])

  if (loading && !data) return <Typography.Text type="secondary">{t('attribution.loading')}</Typography.Text>
  if (!data || data.exactInputTokens === 0) return <Typography.Paragraph type="secondary" data-testid="attribution-no-exact">{t('attribution.noExactInput')}</Typography.Paragraph>
  if (versions.length === 0 || !version) return <Typography.Paragraph type="secondary" data-testid="attribution-empty">{t('attribution.noAttribution')}</Typography.Paragraph>

  const messageKeys = Object.keys(version.composition.messageBlocks)
  const unestimatedMessageBlocks = version.composition.unestimatedMessageBlocks ?? []
  const categories = [t('attribution.system'), t('attribution.tools'), ...messageKeys]
  const toolNames = [...new Set([...Object.keys(data.toolDimensions.tools), ...Object.keys(data.toolDimensions.toolResults)])].sort()
  const topResult = Object.entries(data.toolDimensions.toolResults).sort((a, b) => b[1].chars - a[1].chars)[0]
  const fixed = version.composition.system + version.composition.tools
  const fixedShare = version.attributableInputTokens > 0 ? fixed / version.attributableInputTokens : null
  const tableColumns = [
    { title: t('attribution.toolName'), dataIndex: 'name', key: 'name' },
    { title: t('attribution.declarationChars'), dataIndex: 'declaration', key: 'declaration', align: 'right' as const },
    { title: t('attribution.calls'), dataIndex: 'calls', key: 'calls', align: 'right' as const },
    { title: t('attribution.resultChars'), dataIndex: 'resultChars', key: 'resultChars', align: 'right' as const }
  ]
  const tableRows = toolNames.map((name) => ({
    key: name, name, declaration: number(data.toolDimensions.tools[name] ?? 0, locale),
    calls: number(data.toolDimensions.toolResults[name]?.calls ?? 0, locale),
    resultChars: number(data.toolDimensions.toolResults[name]?.chars ?? 0, locale)
  }))

  return (
    <div className="usage-attribution" data-testid="usage-attribution-view">
      <div className="usage-attribution__toolbar">
        <Typography.Text type="secondary">{t('attribution.exactInput')}</Typography.Text>
        <Typography.Text strong>{number(data.exactInputTokens, locale)}</Typography.Text>
        {versions.length > 1 ? (
          <Select aria-label={t('attribution.estimatorVersion')} value={version.estimatorVersion} onChange={setSelectedVersion}
            options={versions.map((item) => ({ value: item.estimatorVersion, label: item.estimatorVersion }))} />
        ) : <Typography.Text type="secondary">{version.estimatorVersion}</Typography.Text>}
      </div>
      {version.coverageRatio !== null && version.coverageRatio < 1 ? (
        <Typography.Paragraph type="warning" data-testid="attribution-coverage">
          {t('attribution.coverage', { percent: (version.coverageRatio * 100).toFixed(1) })} · {t('attribution.unattributed', { count: number(version.unattributedInputTokens, locale) })}
        </Typography.Paragraph>
      ) : null}
      {unestimatedMessageBlocks.length > 0 ? (
        <Typography.Paragraph type="secondary" data-testid="attribution-unestimated-blocks">
          {t('attribution.unestimatedBlocks', { blocks: unestimatedMessageBlocks.join(', ') })}
        </Typography.Paragraph>
      ) : null}
      <section aria-label={t('attribution.snapshot')}>
        <Typography.Title level={5}>{t('attribution.snapshot')}</Typography.Title>
        <div className="usage-attribution__bar" role="img" aria-label={`${t('attribution.snapshot')} ${version.estimatorVersion}`}>
          {categories.map((category, index) => {
            const value = index === 0 ? version.composition.system : index === 1 ? version.composition.tools : version.composition.messageBlocks[category] ?? 0
            const width = version.attributableInputTokens > 0 ? value / version.attributableInputTokens * 100 : 0
            return width > 0 ? <span key={category} title={`${category}: ${number(value, locale)}`} style={{ width: `${width}%`, background: COLORS[index % COLORS.length] }} /> : null
          })}
        </div>
        <div className="usage-attribution__legend">
          {categories.map((category, index) => {
            const value = index === 0 ? version.composition.system : index === 1 ? version.composition.tools : version.composition.messageBlocks[category] ?? 0
            return <div key={category}><i style={{ background: COLORS[index % COLORS.length] }} />{category}: {number(value, locale)} · ≈ {version.estimatorVersion}</div>
          })}
        </div>
      </section>
      {chartData.length > 0 ? (
        <section aria-label={t('attribution.drift')}>
          <Typography.Title level={5}>{t('attribution.drift')}</Typography.Title>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" />
              <YAxis />
              <Tooltip formatter={(value) => number(Number(value), locale)} />
              <Legend />
              {categories.map((category, index) => <Area key={category} type="monotone" dataKey={category} stackId="usage" stroke={COLORS[index % COLORS.length]} fill={COLORS[index % COLORS.length]} fillOpacity={0.5} />)}
            </AreaChart>
          </ResponsiveContainer>
        </section>
      ) : null}
      {fixedShare !== null ? <div className="usage-attribution__insight">{t('attribution.fixedInsight', { percent: (fixedShare * 100).toFixed(1) })}</div> : null}
      {topResult ? <div className="usage-attribution__insight">{t('attribution.resultInsight', { toolName: topResult[0], chars: number(topResult[1].chars, locale) })}</div> : null}
      <section aria-label={t('attribution.toolDimensions')}>
        <Typography.Title level={5}>{t('attribution.toolDimensions')} · ≈ {version.estimatorVersion}</Typography.Title>
        <Table size="small" pagination={false} columns={tableColumns} dataSource={tableRows} locale={{ emptyText: t('attribution.noToolDimensions') }} />
      </section>
    </div>
  )
}
