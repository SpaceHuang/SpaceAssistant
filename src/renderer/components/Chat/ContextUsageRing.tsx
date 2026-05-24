import { Tooltip } from 'antd'
import { useMemo } from 'react'
import type { LastUsage } from '../../store/chatSlice'

type Props = {
  usage: LastUsage
  maxContext: number
}

const FORMATTER = new Intl.NumberFormat()

function formatTokenCount(n: number | undefined | null): string {
  if (n == null) return ''
  return FORMATTER.format(n)
}

export function ContextUsageRing({ usage, maxContext }: Props) {
  const { totalInput, ratio } = useMemo(() => {
    const inputTokens = usage?.input_tokens ?? 0
    const cacheReadTokens = usage?.cache_read_input_tokens ?? 0
    const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0
    const outputTokens = usage?.output_tokens ?? 0
    const totalInput = inputTokens + cacheReadTokens + cacheWriteTokens
    const total = totalInput + outputTokens
    const ratio = maxContext > 0 ? Math.min(1, total / maxContext) : 0
    return { totalInput, ratio }
  }, [usage, maxContext])

  if (!usage) {
    return null
  }

  const r = 8
  const c = 2 * Math.PI * r
  const strokeDashoffset = c * (1 - ratio)

  let color = '#52c41a' // green for low usage
  if (ratio > 0.9) color = '#ff4d4f' // red for high usage
  else if (ratio > 0.7) color = '#faad14' // orange for medium usage

  const tooltipTitle = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div>输入 Tokens: {formatTokenCount(usage.input_tokens)}</div>
      {usage.cache_read_input_tokens != null && usage.cache_read_input_tokens > 0 && (
        <div>缓存读取: {formatTokenCount(usage.cache_read_input_tokens)}</div>
      )}
      {usage.cache_creation_input_tokens != null && usage.cache_creation_input_tokens > 0 && (
        <div>缓存创建: {formatTokenCount(usage.cache_creation_input_tokens)}</div>
      )}
      <div>输出 Tokens: {formatTokenCount(usage.output_tokens)}</div>
      <div style={{ borderTop: '1px solid #ffffff30', paddingTop: 4, marginTop: 2 }}>
        总计: {formatTokenCount(totalInput + (usage.output_tokens ?? 0))} / {formatTokenCount(maxContext)} ({Math.round(ratio * 100)}%)
      </div>
    </div>
  )

  return (
    <Tooltip title={tooltipTitle} placement="top">
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <svg width={20} height={20} viewBox="0 0 20 20" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={10} cy={10} r={r} fill="none" stroke="#e5e7eb" strokeWidth={2} />
          <circle
            cx={10}
            cy={10}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray={c}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
          />
        </svg>
        <span style={{ fontSize: 12, color: '#8c8c8c' }}>
          {formatTokenCount(totalInput + (usage.output_tokens ?? 0))}
        </span>
      </div>
    </Tooltip>
  )
}
