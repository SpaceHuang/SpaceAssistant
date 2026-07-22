/** 节流：窗口内多次调用仅执行最后一次（trailing） */
export type ThrottledFn<T extends (...args: never[]) => void> = T & { cancel: () => void }

export function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): ThrottledFn<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: Parameters<T> | null = null

  const run = () => {
    timer = null
    if (lastArgs) {
      fn(...lastArgs)
      lastArgs = null
    }
  }

  const throttled = ((...args: Parameters<T>) => {
    lastArgs = args
    if (timer === null) {
      timer = setTimeout(run, ms)
    }
  }) as ThrottledFn<T>

  throttled.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    lastArgs = null
  }

  return throttled
}
