import { describe, expect, it } from 'vitest'
import dayjs, { type Dayjs } from 'dayjs'
import { buildOnceDisabledConstraints, onceAtInFuture } from './onceAtConstraints'

/** 一次性任务执行时间约束：不能选择当前日期 / 时间之前的时间点（评审口径：渲染端约束 + 提交兜底）。 */

const NOW = dayjs('2026-10-20T14:30:45')

describe('buildOnceDisabledConstraints（DatePicker 禁用约束）', () => {
  const { disabledDate, disabledTime } = buildOnceDisabledConstraints(() => NOW)

  it('disabledDate：昨天及更早禁用，今天与未来可选', () => {
    expect(disabledDate(NOW.subtract(1, 'day'))).toBe(true)
    expect(disabledDate(NOW.subtract(30, 'day'))).toBe(true)
    expect(disabledDate(NOW)).toBe(false)
    expect(disabledDate(NOW.add(1, 'day'))).toBe(false)
  })

  it('disabledTime（非当天）：全部开放', () => {
    const t = disabledTime(NOW.add(1, 'day'))
    expect(t.disabledHours()).toEqual([])
    expect(t.disabledMinutes(0)).toEqual([])
    expect(t.disabledSeconds(0, 0)).toEqual([])
  })

  it('disabledTime（当天）：已过小时禁用（0..13），当前及未来小时可选', () => {
    const t = disabledTime(NOW)
    expect(t.disabledHours()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(t.disabledHours()).not.toContain(14)
    expect(t.disabledHours()).not.toContain(15)
  })

  it('disabledTime（当天）：选中当前小时时已过分钟禁用（0..29），其他小时全开放', () => {
    const t = disabledTime(NOW)
    expect(t.disabledMinutes(14)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29
    ])
    expect(t.disabledMinutes(14)).not.toContain(30)
    expect(t.disabledMinutes(15)).toEqual([])
  })

  it('disabledTime（当天）：选中当前时分时已过秒禁用（0..44），其他组合全开放', () => {
    const t = disabledTime(NOW)
    expect(t.disabledSeconds(14, 30)).toEqual(Array.from({ length: 45 }, (_, i) => i))
    expect(t.disabledSeconds(14, 30)).not.toContain(45)
    expect(t.disabledSeconds(14, 31)).toEqual([])
    expect(t.disabledSeconds(15, 0)).toEqual([])
  })
})

describe('onceAtInFuture（提交兜底校验，防手动键入过去时间）', () => {
  it('过去时间点不通过，当前及未来通过，空值交由 required 处理', () => {
    expect(onceAtInFuture(NOW.subtract(1, 'minute'), () => NOW)).toBe(false)
    expect(onceAtInFuture(NOW, () => NOW)).toBe(true)
    expect(onceAtInFuture(NOW.add(1, 'hour'), () => NOW)).toBe(true)
    expect(onceAtInFuture(undefined, () => NOW)).toBe(true)
  })
})
