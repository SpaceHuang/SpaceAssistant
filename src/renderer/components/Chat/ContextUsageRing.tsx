import { useMemo } from 'react'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import { useTypedSelector } from '../../hooks'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { computeContextUsageDisplay } from '../../../shared/contextUsageEstimate'
import { resolveEffectiveOutputMaxTokens } from '../../../shared/llm/outputMaxTokens'

const RING_SIZE = 28
const CENTER = RING_SIZE / 2
const RADIUS = 10
const STROKE_WIDTH = 3

function formatNum(n: number, locale: string): string {
  return n.toLocaleString(locale)
}

type RingSegment = {
  color: string
  dashLen: number
  dashOffset: number
}

/** 在同一圆环上按顺序拼接：已用 | 输出预留 | 剩余（由底色轨道表示） */
export function buildContextRingSegments(
  usedRatio: number,
  reservedRatio: number,
  circumference: number
): RingSegment[] {
  const usedLen = circumference * usedRatio
  const reservedLen = circumference * reservedRatio
  const segments: RingSegment[] = []

  if (usedLen > 0) {
    segments.push({ color: 'var(--sa-primary)', dashLen: usedLen, dashOffset: 0 })
  }
  if (reservedLen > 0) {
    segments.push({ color: 'var(--sa-context-ring-reserved)', dashLen: reservedLen, dashOffset: -usedLen })
  }

  return segments
}

export function ContextUsageRing() {
  const { t } = useTypedTranslation('contextUsage')
  const { i18n } = useTranslation()
  const lastUsage = useTypedSelector((s) => s.chat.lastUsage)
  const config = useTypedSelector((s) => s.config.config)

  const currentModel = useMemo(() => {
    if (!config) return undefined
    return config.models.find((m) => m.name === config.model)
  }, [config])

  const maximumContext = currentModel?.maximumContext
  const effectiveOutputMax =
    config != null
      ? resolveEffectiveOutputMaxTokens(config.model, config.models)
      : undefined

  const hasData =
    lastUsage != null &&
    maximumContext != null &&
    maximumContext > 0 &&
    effectiveOutputMax != null

  const display = useMemo(() => {
    if (!hasData || !lastUsage || !maximumContext || effectiveOutputMax == null) return null
    return computeContextUsageDisplay(lastUsage, maximumContext, effectiveOutputMax)
  }, [hasData, lastUsage, maximumContext, effectiveOutputMax])

  const circumference = 2 * Math.PI * RADIUS

  const segments = useMemo(() => {
    if (!display) return []
    return buildContextRingSegments(display.usedRatio, display.reservedRatio, circumference)
  }, [display, circumference])

  const tooltipTitle = useMemo(() => {
    if (!hasData || !lastUsage || !display) return t('tooltip.noData')

    const locale = i18n.language
    const lines: string[] = []
    lines.push(`${t('tooltip.estimatedOccupancy')}　${formatNum(display.estimatedOccupancy, locale)}`)
    lines.push(`${t('tooltip.lastRequestInput')}　${formatNum(display.totalRequestInput, locale)}`)
    if (display.lastOutput > 0) {
      lines.push(`${t('tooltip.lastOutput')}　${formatNum(display.lastOutput, locale)}`)
    }
    if (lastUsage.cache_read_input_tokens && lastUsage.cache_read_input_tokens > 0) {
      lines.push(`${t('tooltip.cacheRead')}　${formatNum(lastUsage.cache_read_input_tokens, locale)}`)
    }
    if (lastUsage.cache_creation_input_tokens && lastUsage.cache_creation_input_tokens > 0) {
      lines.push(`${t('tooltip.cacheWrite')}　${formatNum(lastUsage.cache_creation_input_tokens, locale)}`)
    }
    lines.push(`${t('tooltip.outputReserve')}　${formatNum(display.effectiveOutputMax, locale)}`)
    lines.push(t('tooltip.separator'))
    lines.push(
      `${t('tooltip.total')} ${formatNum(display.estimatedOccupancy, locale)} / ${formatNum(display.maximumContext, locale)}（${display.percentUsed.toFixed(1)}%）`
    )
    lines.push(
      `${t('tooltip.legend')}　　■ ${t('tooltip.legendUsed')}　■ ${t('tooltip.legendReserved')}　□ ${t('tooltip.legendFree')}`
    )

    return (
      <pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre', lineHeight: 1.6 }}>
        {lines.join('\n')}
      </pre>
    )
  }, [hasData, lastUsage, display, t, i18n.language])

  const ariaLabel =
    hasData && display
      ? t('aria.hasData', { percent: display.percentUsed.toFixed(1) })
      : t('aria.noData')

  return (
    <Tooltip title={tooltipTitle} placement="top">
      <span
        className="context-usage-ring"
        style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}
        aria-label={ariaLabel}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="var(--sa-context-ring-track)"
            strokeWidth={STROKE_WIDTH}
          />
          {segments.map((seg, i) => (
            <circle
              key={i}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={seg.color}
              strokeWidth={STROKE_WIDTH}
              strokeDasharray={`${seg.dashLen} ${circumference - seg.dashLen}`}
              strokeDashoffset={seg.dashOffset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${CENTER} ${CENTER})`}
            />
          ))}
        </svg>
      </span>
    </Tooltip>
  )
}
