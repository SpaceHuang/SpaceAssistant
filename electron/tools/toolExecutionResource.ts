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

/** 读类工具 fs 异常的降级分类；null 表示不属于可降级错误，维持向上抛出的现状。 */
export type FileReadErrorClass = 'transient' | 'environment'

/**
 * 读工具（read_file/grep）无副作用，fs 异常转成工具级失败结果让模型重试即可，
 * 不应冒泡成 ToolExecutionAfterDispatchError 把整轮打成 interrupted。
 * transient：重试可能成功（句柄/资源类瞬态）；environment：重试无意义但工具级返回仍优于整轮中断。
 */
export function classifyFileReadError(err: unknown): FileReadErrorClass | null {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  if (code === 'EBADF' || code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE' || code === 'EAGAIN') return 'transient'
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ELOOP') return 'environment'
  return null
}

/** 按 errno 给出模型可执行的下一步指引（配合降级文案，让模型能自助选择重试/换路径/放弃）。 */
export function fileReadErrorHint(cls: FileReadErrorClass, code: string | undefined): string {
  if (code === 'ENOENT') return '文件可能不存在或路径有误，可先用 list_directory 确认目录内容'
  if (code === 'EACCES' || code === 'EPERM') return '没有访问权限，请检查文件权限后重试'
  if (code === 'EISDIR') return '该路径是目录而非文件，请改用 list_directory 或指定具体文件'
  if (code === 'ELOOP') return '路径的符号链接存在循环，请改用真实文件路径'
  return cls === 'transient'
    ? '文件系统瞬时错误，可重试该工具调用'
    : '请检查目标文件的状态与访问权限'
}

/**
 * 库内约定：executor 已进入后若副作用是否发生不确定，必须抛 `*UncertainError`
 * （SafeAtomicWrite / Browser / RunShell / RunScript / LarkCli / WeChatOutbound /
 * RemoteSessionSwitch / McpTool / CapabilityExecution…）。这类错误必须穿透任何降级出口，
 * 继续按 unknown-after-dispatch 中断整轮；其余漏网异常才允许降级为工具级结果。
 */
export function isExecutionOutcomeUncertainError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const constructorName = error.constructor?.name ?? ''
  return /UncertainError$/.test(error.name) || /UncertainError$/.test(constructorName)
}
