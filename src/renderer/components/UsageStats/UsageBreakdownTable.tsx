import { Table, Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageToolAttributionBreakdown } from '../../../shared/usageStatsTypes'
import { formatInteger } from './format'

type Props = {
  breakdown: UsageToolAttributionBreakdown
}

/** 明细排行（视图③）：字符口径数值带【派生】标注，不呈现为 token（I2/AT4）。 */
export function UsageBreakdownTable({ breakdown }: Props) {
  const { t } = useTypedTranslation('usageStats')
  const derivedMark = t('composition.derived')

  return (
    <div data-testid="usage-breakdown-table">
      <Typography.Text type="secondary">{t('composition.breakdown.title')}</Typography.Text>
      <Table
        size="small"
        style={{ marginTop: 8 }}
        rowKey="name"
        dataSource={breakdown.used}
        pagination={false}
        onRow={(record) => ({ 'data-testid': 'usage-breakdown-row', 'data-tool': record.name } as React.HTMLAttributes<HTMLTableRowElement>)}
        columns={[
          { title: t('composition.breakdown.tool'), dataIndex: 'name', key: 'name' },
          { title: t('composition.breakdown.source'), dataIndex: 'source', key: 'source', width: 90 },
          { title: `${t('composition.breakdown.declaredChars')}（${derivedMark}）`, dataIndex: 'declaredChars', key: 'declaredChars', width: 150, render: (value: number) => formatInteger(value) },
          { title: t('composition.breakdown.calls'), dataIndex: 'calls', key: 'calls', width: 100, render: (value: number | null) => (value == null ? '—' : formatInteger(value)) },
          { title: `${t('composition.breakdown.resultChars')}（${derivedMark}）`, dataIndex: 'resultChars', key: 'resultChars', width: 160, render: (value: number | null) => (value == null ? '—' : formatInteger(value)) }
        ]}
      />
      <div data-testid="usage-breakdown-unused" style={{ marginTop: 12 }}>
        <Typography.Text type="secondary">
          {t('composition.breakdown.unusedTitle')}
          {breakdown.unused.length > 0 ? `：${t('composition.breakdown.unusedCount', { count: breakdown.unused.length })}` : ''}
        </Typography.Text>
        {breakdown.unused.length > 0 ? (
          <div style={{ marginTop: 4 }}>
            {breakdown.unused.map((entry) => (
              <Typography.Text key={entry.name} style={{ fontSize: 12, display: 'inline-block', marginRight: 12 }}>
                {entry.name}（{formatInteger(entry.declaredChars)}）
              </Typography.Text>
            ))}
          </div>
        ) : (
          <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0 }}>
            {t('composition.breakdown.unusedEmpty')}
          </Typography.Paragraph>
        )}
      </div>
    </div>
  )
}
