/** 数值展示工具（需求 §3：>100 万缩写 + 悬停精确值；计数千分位；比率 1 位小数）。 */

export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  }
  return formatInteger(value)
}

export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toFixed(2)
}

export function formatLocalDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 当前时区标识（DIM1：避免跨时区误读），offsetMinutes 为 Date.getTimezoneOffset()。 */
export function localTimeZoneLabel(_now: number, offsetMinutes: number): string {
  const sign = offsetMinutes <= 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(offsetMinutes) / 60)
  return `UTC${sign}${hours}`
}
