import dayjs, { type Dayjs } from 'dayjs'

/**
 * 一次性任务执行时间约束（不能选择当前日期 / 时间之前的时间点）：
 * - disabledDate / disabledTime 供 DatePicker 面板禁用（日期层 + 当天的时分秒层）；
 * - onceAtInFuture 供提交兜底校验（面板禁用挡不住手动键入的过去时间）。
 * 主进程侧不加「必须未来」限制：at 已过的行为是既有设计（到点立即执行 / 重新启用再跑一次），
 * 渲染端只表达意图，主进程决定语义。
 */

function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i < end; i += 1) out.push(i)
  return out
}

export function buildOnceDisabledConstraints(now: () => Dayjs = () => dayjs()): {
  disabledDate: (current: Dayjs) => boolean
  disabledTime: (current?: Dayjs) => {
    disabledHours: () => number[]
    disabledMinutes: (selectedHour: number) => number[]
    disabledSeconds: (selectedHour: number, selectedMinute: number) => number[]
  }
} {
  const disabledDate = (current: Dayjs) => current.isBefore(now().startOf('day'))
  const disabledTime = (current?: Dayjs) => {
    const nowValue = now()
    if (!current || !current.isSame(nowValue, 'day')) {
      return {
        disabledHours: () => [],
        disabledMinutes: () => [],
        disabledSeconds: () => []
      }
    }
    return {
      disabledHours: () => range(0, nowValue.hour()),
      disabledMinutes: (selectedHour: number) =>
        selectedHour === nowValue.hour() ? range(0, nowValue.minute()) : [],
      disabledSeconds: (selectedHour: number, selectedMinute: number) =>
        selectedHour === nowValue.hour() && selectedMinute === nowValue.minute()
          ? range(0, nowValue.second())
          : []
    }
  }
  return { disabledDate, disabledTime }
}

/** 提交兜底校验：仅拒绝「早于当前时间」的值；空值交由 Form 的 required 规则处理。 */
export function onceAtInFuture(value: Dayjs | undefined | null, now: () => Dayjs = () => dayjs()): boolean {
  if (!value) return true
  return !value.isBefore(now())
}
