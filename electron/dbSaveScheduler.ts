/** JSON DB 落盘防抖间隔（阶段 4：写入合并，降低多会话并行时的 I/O 放大） */
export const DB_SAVE_DEBOUNCE_MS = 250

export function createDebouncedDbSave(writeFn: () => void, debounceMs = DB_SAVE_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  // 挂起（压缩换入窗口专用）：schedule 只记脏标记、不再安排 checkpoint 写主库文件，
  // 保证 worker 复制主库期间文件零变化；显式 flushNow 不受挂起影响（编排器复核仍可强制落盘）。
  let suspended = false

  const schedule = () => {
    dirty = true
    if (suspended || timer) return
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

  const setSuspended = (value: boolean) => {
    suspended = value
    if (!value && dirty && !timer) schedule()
  }

  return { schedule, flushNow, setSuspended }
}
