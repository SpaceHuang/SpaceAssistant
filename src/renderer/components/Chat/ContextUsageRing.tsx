import { useMemo } from 'react'
import { Tooltip } from 'antd'
import { useTypedSelector } from '../../hooks'
import { computeContextUsageDisplay } from '../../../shared/contextUsageEstimate'
import { resolveEffectiveOutputMaxTokens } from '../../../shared/llm/outputMaxTokens'

const RING_SIZE = 28
const CENTER = RING_SIZE / 2
const RADIUS = 10
const STROKE_WIDTH = 3

function formatNum(n: number): string {
  return n.toLocaleString('zh-CN')
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
    segments.push({ color: '#666', dashLen: reservedLen, dashOffset: -usedLen })
  }

  return segments
}

export function ContextUsageRing() {
  const lastUsage = useTypedSelector((s) => s.chat.lastUsage)
  const config = useTypedSelector((s) => s.config.config)

  const currentModel = useMemo(() => {
    if (!config) return undefined
    return config.models.find((m) => m.name === config.model)
  }, [config])

  const maximumContext = currentModel?.maximumContext
  const effectiveOutputMax =
    config != null
      ? resolveEffectiveOutputMaxTokens(config.model, config.models, config.maxTokens)
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
    if (!hasData || !lastUsage || !display) return '暂无上下文用量数据'

    const lines: string[] = []
    lines.push(`预估占用　${formatNum(display.estimatedOccupancy)}`)
    lines.push(`上轮输入　${formatNum(display.totalRequestInput)}`)
    if (display.lastOutput > 0) {
      lines.push(`上轮输出　${formatNum(display.lastOutput)}`)
    }
    if (lastUsage.cache_read_input_tokens && lastUsage.cache_read_input_tokens > 0) {
      lines.push(`缓存命中　${formatNum(lastUsage.cache_read_input_tokens)}`)
    }
    if (lastUsage.cache_creation_input_tokens && lastUsage.cache_creation_input_tokens > 0) {
      lines.push(`缓存写入　${formatNum(lastUsage.cache_creation_input_tokens)}`)
    }
    lines.push(`输出预留　${formatNum(display.effectiveOutputMax)}`)
    lines.push(`─────────`)
    lines.push(
      `总计 ${formatNum(display.estimatedOccupancy)} / ${formatNum(display.maximumContext)}（${display.percentUsed.toFixed(1)}%）`
    )
    lines.push(`图例　　■ 已用　■ 输出预留　□ 剩余`)

    return (
      <pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre', lineHeight: 1.6 }}>
        {lines.join('\n')}
      </pre>
    )
  }, [hasData, lastUsage, display])

  return (
    <Tooltip title={tooltipTitle} placement="top">
      <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}>
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="#ddd"
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
