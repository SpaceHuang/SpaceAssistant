import { describe, expect, it } from 'vitest'
import { formatCount, formatInteger, formatLocalDay, formatPercent, formatRatio, localTimeZoneLabel } from './format'

describe('formatCount 数值展示（§3 展示要求 + 按语言进位习惯）', () => {
  it('英文：百万以上 M、千以上 K，其余千分位', () => {
    expect(formatCount(1_280_000, 'en-US')).toBe('1.28M')
    expect(formatCount(1_000_000, 'en-US')).toBe('1M')
    expect(formatCount(5_900, 'en-US')).toBe('5.9K')
    expect(formatCount(10_000, 'en-US')).toBe('10K')
    expect(formatCount(1_234_567_890, 'en-US')).toBe('1234.57M')
    expect(formatCount(342, 'en-US')).toBe('342')
  })

  it('中文：亿 / 万进位（如总 Tokens 消耗 5.9 亿），不足一万千分位', () => {
    expect(formatCount(590_000_000, 'zh-CN')).toBe('5.9 亿')
    expect(formatCount(1_000_000_000, 'zh-CN')).toBe('10 亿')
    expect(formatCount(12_800_000, 'zh-CN')).toBe('1280 万')
    expect(formatCount(59_000, 'zh-CN')).toBe('5.9 万')
    expect(formatCount(3_420, 'zh-CN')).toBe('3,420')
    expect(formatCount(0, 'zh-CN')).toBe('0')
    expect(formatCount(999_999, 'zh-CN')).toBe('100 万')
  })

  it('默认语言按英文习惯（保持既有调用兼容）', () => {
    expect(formatCount(1_280_000)).toBe('1.28M')
    // 999,999 舍入后达到 1000K，升档显示 1M（而非 1000K 或千分位）
    expect(formatCount(999_999)).toBe('1M')
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
