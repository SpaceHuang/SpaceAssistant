import { useMemo } from 'react'
import { Tooltip } from 'antd'
import { useTypedSelector } from '../../hooks'
import type { LastUsage } from '../../store/chatSlice'

const RING_SIZE = 28
const CENTER = RING_SIZE / 2
const RADII = [11, 8, 5]
const STROKE_WIDTHS = [3, 2.5, 2]

function formatNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

export function ContextUsageRing() {
  const lastUsage = useTypedSelector((s) => s.chat.lastUsage)
  const config = useTypedSelector((s) => s.config.config)

  const currentModel = useMemo(() => {
    if (!config) return undefined
    return config.models.find((m) => m.name === config.model)
  }, [config])

  const maximumContext = currentModel?.maximumContext
  const maxTokens = config?.maxTokens

  const hasData = lastUsage != null && maximumContext != null && maximumContext > 0

  const layers = useMemo(() => {
    if (!hasData || !lastUsage || !maximumContext || maxTokens == null) {
      return [{ color: '#ddd', ratio: 1 }]
    }

    const total = maximumContext
    let inputRatio = lastUsage.input_tokens / total
    let reservedRatio = maxTokens / total

    if (inputRatio + reservedRatio > 1) {
      const scale = 1 / (inputRatio + reservedRatio)
      inputRatio *= scale
      reservedRatio *= scale
    }

    const freeRatio = Math.max(0, 1 - inputRatio - reservedRatio)

    return [
      { color: 'var(--sa-primary)', ratio: inputRatio },
      { color: '#666', ratio: reservedRatio },
      { color: '#ddd', ratio: freeRatio }
    ]
  }, [hasData, lastUsage, maximumContext, maxTokens])

  const tooltipTitle = useMemo(() => {
    if (!hasData || !lastUsage) return '暂无上下文用量数据'

    const lines: string[] = []
    lines.push(`输入消耗　${formatNum(lastUsage.input_tokens)}`)
    if (lastUsage.output_tokens != null) {
      lines.push(`输出消耗　${formatNum(lastUsage.output_tokens)}`)
    }
    if (lastUsage.cache_read_input_tokens && lastUsage.cache_read_input_tokens > 0) {
      lines.push(`缓存命中　${formatNum(lastUsage.cache_read_input_tokens)}`)
    }
    if (lastUsage.cache_creation_input_tokens && lastUsage.cache_creation_input_tokens > 0) {
      lines.push(`缓存写入　${formatNum(lastUsage.cache_creation_input_tokens)}`)
    }
    if (maximumContext) {
      const pct = ((lastUsage.input_tokens / maximumContext) * 100).toFixed(1)
      lines.push(`─────────`)
      lines.push(`总计 ${formatNum(lastUsage.input_tokens)} / ${formatNum(maximumContext)}（${pct}%）`)
    }

    return (
      <pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre', lineHeight: 1.6 }}>
        {lines.join('\n')}
      </pre>
    )
  }, [hasData, lastUsage, maximumContext])

  return (
    <Tooltip title={tooltipTitle} placement="top">
      <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}>
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
          {layers.map((layer, i) => {
            const r = RADII[i] ?? RADII[0]
            const sw = STROKE_WIDTHS[i] ?? STROKE_WIDTHS[0]
            const circumference = 2 * Math.PI * r
            const dashLen = circumference * layer.ratio
            const gapLen = circumference - dashLen
            return (
              <circle
                key={i}
                cx={CENTER}
                cy={CENTER}
                r={r}
                fill="none"
                stroke={layer.color}
                strokeWidth={sw}
                strokeDasharray={`${dashLen} ${gapLen}`}
                strokeLinecap="butt"
                transform={`rotate(-90 ${CENTER} ${CENTER})`}
              />
            )
          })}
        </svg>
      </span>
    </Tooltip>
  )
}