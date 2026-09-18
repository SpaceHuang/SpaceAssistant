import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, DatePicker, Drawer, Radio, Select, Space, Spin, Typography } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageDailyPoint, UsageDimensions, UsageStatsFilters, UsageStatsRangeArgs, UsageSummary } from '../../../shared/usageStatsTypes'
import { UsageStatsKpiCards } from './UsageStatsKpiCards'
import { UsageTrendChart } from './UsageTrendChart'
import { formatLocalDay, localTimeZoneLabel } from './format'

type Props = {
  open: boolean
  onClose: () => void
}

type RangePreset = '7' | '30' | '90' | 'custom'

const { RangePicker } = DatePicker

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + n)
  return formatLocalDay(date)
}

/** Token 用量统计面板（C6：Drawer 宽 86%，destroyOnClose；筛选状态在面板会话内保持，关闭即重置）。 */
export function UsageStatsDrawer({ open, onClose }: Props) {
  const { t } = useTypedTranslation('usageStats')
  const [preset, setPreset] = useState<RangePreset>('30')
  const [customRange, setCustomRange] = useState<[string, string] | null>(null)
  const [filters, setFilters] = useState<UsageStatsFilters>({})
  const [dimensions, setDimensions] = useState<UsageDimensions | null>(null)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [points, setPoints] = useState<UsageDailyPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const today = useMemo(() => formatLocalDay(new Date()), [])
  // 默认近 30 天（含今天）：[today-29, today]；自定义跨度超过 365 天时截断（§5.3.1）
  const [from, to] = useMemo<[string, string]>(() => {
    if (preset === 'custom' && customRange) {
      const [rawFrom, rawTo] = customRange
      let nextFrom = rawFrom
      const nextTo = rawTo
      if (daysBetween(nextFrom, nextTo) > 365) {
        nextFrom = shiftDay(nextTo, -365)
      }
      return [nextFrom, nextTo]
    }
    const days = Number(preset)
    return [shiftDay(today, -(days - 1)), today]
  }, [preset, customRange, today])

  const rangeTooLong = preset === 'custom' && customRange !== null && daysBetween(customRange[0], customRange[1]) > 365

  const fetchData = useCallback(async (args: UsageStatsRangeArgs) => {
    setLoading(true)
    setLoadError(false)
    try {
      const [nextSummary, nextPoints, nextDimensions] = await Promise.all([
        window.api.usageStatsSummary(args),
        window.api.usageStatsDaily(args),
        window.api.usageStatsDimensions()
      ])
      setSummary(nextSummary)
      setPoints(nextPoints)
      setDimensions(nextDimensions)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void fetchData({ from, to, dimensions: filters })
  }, [open, from, to, filters, fetchData])

  const hasNoData = !loading && !loadError && (summary === null || summary.totalTokens === 0) && points.every((p) => p.inputTokens === 0 && p.outputTokens === 0)

  return (
    <Drawer
      title={t('title')}
      width="86%"
      open={open}
      onClose={onClose}
      destroyOnClose
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap align="center">
          <Typography.Text type="secondary">{t('range.label')}</Typography.Text>
          <Radio.Group
            value={preset}
            onChange={(e) => {
              const next = e.target.value as RangePreset
              setPreset(next)
              if (next !== 'custom') setCustomRange(null)
            }}
            optionType="button"
            options={[
              { value: '7', label: t('range.last7') },
              { value: '30', label: t('range.last30') },
              { value: '90', label: t('range.last90') },
              { value: 'custom', label: t('range.custom') }
            ]}
          />
          {preset === 'custom' && (
            <RangePicker
              value={customRange ? ([customRange[0], customRange[1]] as unknown as never) : null}
              onChange={(_, dateString) => {
                const [rawFrom, rawTo] = dateString as [string, string]
                if (rawFrom && rawTo) setCustomRange([rawFrom, rawTo])
              }}
              allowClear={false}
            />
          )}
          <Typography.Text type="secondary" data-testid="usage-tz-hint">
            {t('timezoneHint', { tz: localTimeZoneLabel(Date.now(), new Date().getTimezoneOffset()) })}
          </Typography.Text>
        </Space>
        {rangeTooLong && <Alert type="warning" showIcon message={t('rangeTooLong')} />}
        <Space wrap align="center">
          <Typography.Text type="secondary">{t('filters.model')}</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 220 }}
            maxTagCount="responsive"
            placeholder={dimensions?.models.length ? undefined : t('filters.noOptions')}
            value={filters.models?.map((m) => modelOptionValue(m.model, m.llmServiceId)) ?? []}
            onChange={(values) => {
              const nextModels = (values as string[]).map(parseModelOptionValue)
              setFilters((prev) => ({ ...prev, models: nextModels.length > 0 ? nextModels : undefined }))
            }}
            options={(dimensions?.models ?? []).map((m) => ({
              value: modelOptionValue(m.model, m.llmServiceId),
              label: modelOptionLabel(m.model, m.llmServiceId)
            }))}
          />
          <Typography.Text type="secondary">{t('filters.session')}</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 180 }}
            maxTagCount="responsive"
            value={filters.sessionIds ?? []}
            onChange={(values) => {
              const next = values as string[]
              setFilters((prev) => ({ ...prev, sessionIds: next.length > 0 ? next : undefined }))
            }}
            options={(dimensions?.sessions ?? []).map((s) => ({
              value: s.sessionId,
              label: s.name ?? t('filters.deletedSession')
            }))}
          />
          <Typography.Text type="secondary">{t('filters.version')}</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 140 }}
            maxTagCount="responsive"
            value={filters.appVersions ?? []}
            onChange={(values) => {
              const next = values as string[]
              setFilters((prev) => ({ ...prev, appVersions: next.length > 0 ? next : undefined }))
            }}
            options={(dimensions?.appVersions ?? []).map((v) => ({ value: v, label: v }))}
          />
        </Space>
        {loadError && <Alert type="error" showIcon message={t('loadFailed')} />}
        {hasNoData ? (
          <Typography.Paragraph type="secondary" data-testid="usage-empty">
            {t('empty')}
          </Typography.Paragraph>
        ) : (
          <Spin spinning={loading}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <UsageStatsKpiCards summary={summary} loading={loading} />
              <div data-testid="usage-trend-chart">
                <UsageTrendChart points={points} />
              </div>
            </Space>
          </Spin>
        )}
      </Space>
    </Drawer>
  )
}

function modelOptionValue(model: string, llmServiceId?: string): string {
  return llmServiceId ? `${model}::${llmServiceId}` : model
}

function modelOptionLabel(model: string, llmServiceId?: string): string {
  return llmServiceId ? `${llmServiceId} / ${model}` : model
}

function parseModelOptionValue(value: string): { model: string; llmServiceId?: string } {
  const idx = value.indexOf('::')
  if (idx >= 0) return { model: value.slice(0, idx), llmServiceId: value.slice(idx + 2) }
  return { model: value }
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0
  const fromMs = new Date(fy, fm - 1, fd).getTime()
  const toMs = new Date(ty, tm - 1, td).getTime()
  return Math.round((toMs - fromMs) / 86_400_000)
}
