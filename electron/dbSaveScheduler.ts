/** JSON DB 落盘防抖间隔（阶段 4：写入合并，降低多会话并行时的 I/O 放大） */
export const DB_SAVE_DEBOUNCE_MS = 250

export function createDebouncedDbSave(writeFn: () => void, debounceMs = DB_SAVE_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  const schedule = () => {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (!dirty) return
      dirty = false
      writeFn()
    }, debounceMs)
  }

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    dirty = false
    writeFn()
  }

  return { schedule, flushNow }
}
