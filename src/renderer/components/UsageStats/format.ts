/** 数值展示工具（§3：缩写 + 悬停精确值；计数千分位；比率 1 位小数）。
 *  缩写按界面语言进位：英文 K / M，中文万 / 亿（如「5.9 亿」）。 */

export type AbbreviationLocale = 'zh-CN' | 'en-US'

export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** 去尾零的两位小数（1.00 → 1，1280.50 → 1280.5）。 */
function abbreviate(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '')
}

export function formatCount(value: number, locale: AbbreviationLocale = 'en-US'): string {
  if (locale === 'zh-CN') {
    // 中文进位习惯：万（1e4）、亿（1e8）；不足一万用千分位（1000 万是自然表述，不强制升亿）
    if (value >= 1e8) return `${abbreviate(value / 1e8)} 亿`
    if (value >= 1e4) return `${abbreviate(value / 1e4)} 万`
    return formatInteger(value)
  }
  // 英文进位习惯：K（1e3）、M（1e6）；不足一千用千分位
  if (value >= 1e6) return `${abbreviate(value / 1e6)}M`
  if (value >= 1e3) {
    // 舍入后达到 1000K 的（如 999,999）升档显示 1M
    if (value / 1e3 >= 999.995) return `${abbreviate(value / 1e6)}M`
    return `${abbreviate(value / 1e3)}K`
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
