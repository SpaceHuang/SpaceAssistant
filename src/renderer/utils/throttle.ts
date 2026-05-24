/** 节流：窗口内多次调用仅执行最后一次（trailing） */
export function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: Parameters<T> | null = null

  const run = () => {
    timer = null
    if (lastArgs) {
      fn(...lastArgs)
      lastArgs = null
    }
  }

  return ((...args: Parameters<T>) => {
    lastArgs = args
    if (timer === null) {
      timer = setTimeout(run, ms)
    }
  }) as T
}
