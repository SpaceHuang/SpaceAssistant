import { describe, expect, it } from 'vitest'
import { formatCount, formatInteger, formatLocalDay, formatPercent, formatRatio, localTimeZoneLabel } from './format'

describe('formatCount 数值展示（§3 展示要求）', () => {
  it('超过 100 万用缩写（M，2 位小数）', () => {
    expect(formatCount(1280000)).toBe('1.28M')
    expect(formatCount(1_000_000)).toBe('1M')
    expect(formatCount(1_234_567_890)).toBe('1234.57M')
  })

  it('百万以内千分位分隔', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(342)).toBe('342')
    expect(formatCount(999_999)).toBe('999,999')
  })
})

describe('formatInteger / formatPercent / formatRatio', () => {
  it('千分位', () => {
    expect(formatInteger(438)).toBe('438')
    expect(formatInteger(12000)).toBe('12,000')
  })

  it('比率保留 1 位小数；null 显示 —', () => {
    expect(formatPercent(0.782)).toBe('78.2%')
    expect(formatPercent(1)).toBe('100.0%')
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(null)).toBe('—')
  })

  it('平均步数保留 2 位小数', () => {
    expect(formatRatio(3.42)).toBe('3.42')
    expect(formatRatio(null)).toBe('—')
  })
})

describe('日期与时区', () => {
  it('本地自然日格式化', () => {
    expect(formatLocalDay(new Date(2026, 8, 16))).toBe('2026-09-16')
  })

  it('时区标识（UTC±n，offset 语义同 Date.getTimezoneOffset）', () => {
    expect(localTimeZoneLabel(0, -480)).toBe('UTC+8')
    expect(localTimeZoneLabel(0, 0)).toBe('UTC+0')
    expect(localTimeZoneLabel(0, 300)).toBe('UTC-5')
  })
})
