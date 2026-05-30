/** 文件类内置工具：用户取消 + 文档 §5.6 默认 30s 超时 */

export const FILE_TOOL_TIMEOUT_MS = 30_000

/** 用于与 `ctx.signal`（用户取消）区分超时分支 */
export const FILE_TOOL_TIMEOUT_REASON = Symbol('SpaceAssistant:FileToolTimeout')

export type FileToolAbortOutcome = 'timeout' | 'cancel' | null

/**
 * 合并用户取消与固定超时：返回的合成 signal 在任一侧触发时 abort。
 * 调用方必须在 `finally` 中调用 `dispose()`，避免泄漏定时器与监听器。
 */
export function combineUserAbortAndTimeout(
  userSignal: AbortSignal,
  timeoutMs: number = FILE_TOOL_TIMEOUT_MS
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const cleanupTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const onUserAbort = () => {
    cleanupTimer()
    userSignal.removeEventListener('abort', onUserAbort)
    ctrl.abort(userSignal.reason)
  }

  const dispose = () => {
    cleanupTimer()
    userSignal.removeEventListener('abort', onUserAbort)
  }

  timer = setTimeout(() => {
    timer = undefined
    userSignal.removeEventListener('abort', onUserAbort)
    ctrl.abort(FILE_TOOL_TIMEOUT_REASON)
  }, timeoutMs)

  if (userSignal.aborted) {
    dispose()
    ctrl.abort(userSignal.reason)
  } else {
    userSignal.addEventListener('abort', onUserAbort, { once: true })
  }

  return { signal: ctrl.signal, dispose }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

export function isUserAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/**
 * 在用户中止（聊天中止 / tool:cancel）时拒绝；可选 onAbort 用于打断底层 I/O（如 page.goto）。
 */
export function raceWithUserAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbortHandler = () => {
      cleanup()
      try {
        onAbort?.()
      } catch {
        /* ignore */
      }
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbortHandler)
    signal.addEventListener('abort', onAbortHandler, { once: true })
    promise.then(
      (v) => {
        cleanup()
        resolve(v)
      },
      (e) => {
        cleanup()
        reject(e)
      }
    )
  })
}

export function outcomeFromFileToolSignal(op: AbortSignal): FileToolAbortOutcome {
  if (!op.aborted) return null
  if (op.reason === FILE_TOOL_TIMEOUT_REASON) return 'timeout'
  return 'cancel'
}
