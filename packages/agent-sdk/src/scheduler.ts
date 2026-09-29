export type ToolNode<T> = {
  id: string
  dependsOn?: string[]
  resourceKeys?: readonly string[]
  run: () => Promise<T> | T
  isSuccess?: (value: T) => boolean
  onDependencyFailure?: (dependencies: readonly string[]) => Promise<T> | T
}

/**
 * 节点在启动前无法取得外部资源预留，且调用方没有提供进度事件订阅时的可恢复错误。
 * 调度器不能在这个状态下同步重试，否则会阻塞释放资源的事件循环。
 */
export type ToolSchedulerReservationErrorReason = 'no-progress-subscription' | 'progress-timeout'

export class ToolSchedulerReservationError extends Error {
  readonly code = 'tool-reservation-unavailable' as const
  readonly retryable = true as const

  constructor(readonly reason: ToolSchedulerReservationErrorReason = 'no-progress-subscription') {
    super(reason === 'progress-timeout'
      ? 'tool reservation progress notification timed out; retry the invocation'
      : 'tool reservation unavailable; provide progress notifications or retry the invocation')
    this.name = 'ToolSchedulerReservationError'
  }
}

export const DEFAULT_PROGRESS_WAIT_TIMEOUT_MS = 30_000

function resourcesConflict(a: string, b: string): boolean {
  if (a === b) return true
  // workspace 键代表文件系统路径：目录读取/写入必须与其子路径操作串行，
  // 但 /src 与 /src2 仍是独立资源。
  const workspacePrefix = 'workspace:'
  if (!a.startsWith(workspacePrefix) || !b.startsWith(workspacePrefix)) return false
  const [left, right] = [a.slice(workspacePrefix.length), b.slice(workspacePrefix.length)].map((value) =>
    value.length > 1 ? value.replace(/\/+$/, '') : value
  )
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Core 对 Runtime park 的最小判定：只有没有其它可运行节点时才能让出父租约。 */
export function canParkInvocation(activeNodeCount: number, waitingApprovalCount: number): boolean {
  return Number.isInteger(activeNodeCount)
    && Number.isInteger(waitingApprovalCount)
    && activeNodeCount > 0
    && waitingApprovalCount >= activeNodeCount
}

/** Dependency scheduler with an injected per-invocation execution bound. */
export class ToolScheduler {
  constructor(private readonly options: {
    maxConcurrent?: number
    isWaiting?: (id: string) => boolean
    /** 在节点真正启动前预留资源；返回 false 时节点留在计划中。 */
    tryReserveStart?: (id: string) => boolean
    releaseStart?: (id: string) => void
    subscribeProgress?: (notify: () => void) => () => void
    /** 有订阅但宿主失联时的最大等待时间，避免调度调用永久悬挂。 */
    progressWaitTimeoutMs?: number
  } = {}) {}

  async run<T>(nodes: ToolNode<T>[]): Promise<Record<string, T>> {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const results = new Map<string, T>()
    const failed = new Set<string>()
    const remaining = new Set(nodes.map((node) => node.id))
    const running = new Map<string, Promise<T>>()
    // 每个节点只创建一次完成映射；审批长时间等待时，调度循环的唤醒
    // 不会反复给同一个 Promise 挂新的 async 回调。
    const completionSignals = new Map<string, Promise<[string, T]>>()
    let progressNotify: (() => void) | undefined
    let progressSignal = new Promise<void>((resolve) => { progressNotify = resolve })
    const notifyProgress = () => {
      progressNotify?.()
      progressSignal = new Promise<void>((resolve) => { progressNotify = resolve })
    }
    const unsubscribeProgress = this.options.subscribeProgress?.(notifyProgress)
    try {
    const progressWaitTimeoutMs = this.options.progressWaitTimeoutMs ?? DEFAULT_PROGRESS_WAIT_TIMEOUT_MS
    if (!Number.isFinite(progressWaitTimeoutMs) || progressWaitTimeoutMs <= 0) throw new Error('invalid progressWaitTimeoutMs')
    while (remaining.size || running.size) {
      const ready = [...remaining].filter((id) => (byId.get(id)!.dependsOn ?? []).every((dependency) => results.has(dependency)))
      if (!ready.length && running.size === 0) throw new Error('tool dependency cycle or missing dependency')
      const maxConcurrent = this.options.maxConcurrent ?? Number.POSITIVE_INFINITY
      if (maxConcurrent !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)) throw new Error('invalid maxConcurrent')
      const resources = new Set<string>()
      let started = false
      const unknownRunning = [...running.keys()].some((id) => byId.get(id)!.resourceKeys === undefined)
      for (const id of running.keys()) (byId.get(id)!.resourceKeys ?? []).forEach((key) => resources.add(key))
      for (const id of ready) {
        const activeCount = [...running.keys()].filter((runningId) => !this.options.isWaiting?.(runningId)).length
        if (activeCount >= maxConcurrent) break
        const node = byId.get(id)!
        const dependencies = node.dependsOn ?? []
        const failedDependencies = dependencies.filter((dependency) => failed.has(dependency))
        if (failedDependencies.length) {
          remaining.delete(id)
          const value = node.onDependencyFailure
            ? await node.onDependencyFailure(failedDependencies)
            : undefined as T
          results.set(id, value)
          failed.add(id)
          started = true
          continue
        }
        // 未声明资源的工具视为未知副作用：只能作为单节点串行屏障。
        if (node.resourceKeys === undefined) {
          if (running.size === 0 && !unknownRunning) {
            if (this.options.tryReserveStart && !this.options.tryReserveStart(id)) break
            remaining.delete(id)
            const promise = Promise.resolve(node.run()).finally(() => this.options.releaseStart?.(id))
            running.set(id, promise)
            completionSignals.set(id, promise.then((value) => [id, value] as [string, T]))
            started = true
          }
          break
        }
        if (unknownRunning) break
        if (node.resourceKeys.some((key) => [...resources].some((held) => resourcesConflict(key, held)))) continue
        if (this.options.tryReserveStart && !this.options.tryReserveStart(id)) continue
        node.resourceKeys.forEach((key) => resources.add(key))
        remaining.delete(id)
        const promise = Promise.resolve(node.run()).finally(() => this.options.releaseStart?.(id))
        running.set(id, promise)
        completionSignals.set(id, promise.then((value) => [id, value] as [string, T]))
        started = true
      }
      if (running.size === 0) {
        if (!started && remaining.size > 0) {
          // 预留失败可能发生在首个节点，此时没有 Promise 可以等待。
          // 必须让出事件循环，等待容量释放通知；没有通知协议时显式返回可恢复错误，
          // 不能继续同步循环把取消、定时器和容量释放全部饿死。
          if (!this.options.subscribeProgress) throw new ToolSchedulerReservationError()
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              progressSignal,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new ToolSchedulerReservationError('progress-timeout')), progressWaitTimeoutMs)
                ;(timeout as unknown as { unref?: () => void }).unref?.()
              })
            ])
          } finally {
            if (timeout) clearTimeout(timeout)
          }
        }
        continue
      }
      // 审批等待不会完成 promise；在仍有调度容量时立即重新评估 ready 节点，
      // 使“所有在途节点都等待审批”也不会阻塞后续独立工具。
      const activeCount = [...running.keys()].filter((id) => !this.options.isWaiting?.(id)).length
      if (started) continue
      let completed: [string, T] | undefined
      try {
        completed = await Promise.race([
          ...completionSignals.values(),
          // waiting、reservation、capacity 的变化必须由 Core/Runtime 显式发事件。
          // 不再用 timer 猜测节点何时从 executing 切到 waiting；否则审批等待期间
          // 会持续轮询并累积回调，也会在事件尚未到达时卡住独立节点。
          progressSignal.then(() => undefined)
        ]) as [string, T] | undefined
      } catch (error) {
        await Promise.allSettled([...running.values()])
        throw error
      }
      if (!completed) continue
      running.delete(completed[0])
      completionSignals.delete(completed[0])
      results.set(completed[0], completed[1])
      const completedNode = byId.get(completed[0])!
      if (completedNode.isSuccess && !completedNode.isSuccess(completed[1])) failed.add(completed[0])
    }
    return Object.fromEntries(results) as Record<string, T>
    } finally {
      unsubscribeProgress?.()
    }
  }

  /** 并发执行后按输入顺序归并，供模型 tool_result 保持稳定序列。 */
  async runOrdered<T>(nodes: ToolNode<T>[]): Promise<Array<{ id: string; value: T }>> {
    const results = await this.run(nodes)
    return nodes.map((node) => ({ id: node.id, value: results[node.id]! }))
  }
}

export type RuntimeLease = { runtimeId: string; invocationId: string; generation: number; release: () => void }
export type ParkHandle = { runtimeId: string; invocationId: string; generation: number; checkpoint: unknown }

export class InvocationRuntime {
  private generation = 0
  private active = new Map<string, number>()
  private parked = new Map<string, ParkHandle>()
  constructor(readonly runtimeId: string, private readonly options: { maxParkedTurns?: number } = {}) {
    if (options.maxParkedTurns !== undefined && (!Number.isInteger(options.maxParkedTurns) || options.maxParkedTurns < 1)) {
      throw new Error('maxParkedTurns must be positive')
    }
  }

  acquireLease(invocationId: string): RuntimeLease {
    const generation = ++this.generation
    if (this.active.has(invocationId) || this.parked.has(invocationId)) throw new Error('invocation already leased')
    this.active.set(invocationId, generation)
    let released = false
    return { runtimeId: this.runtimeId, invocationId, generation, release: () => {
      if (released) return
      released = true
      if (this.active.get(invocationId) === generation) this.active.delete(invocationId)
    } }
  }

  park(invocationId: string, lease: RuntimeLease, checkpoint: unknown = {}): ParkHandle | undefined {
    if (this.active.get(invocationId) !== lease.generation || lease.runtimeId !== this.runtimeId || lease.invocationId !== invocationId || lease.generation <= 0) return undefined
    const maxParkedTurns = this.options.maxParkedTurns ?? 32
    if (this.parked.size >= maxParkedTurns) return undefined
    const handle = { runtimeId: this.runtimeId, invocationId, generation: lease.generation, checkpoint }
    this.parked.set(invocationId, handle)
    this.active.delete(invocationId)
    return handle
  }

  resume(handle: ParkHandle): boolean {
    const current = this.parked.get(handle.invocationId)
    if (!current || current.runtimeId !== this.runtimeId || current.generation !== handle.generation) return false
    this.parked.delete(handle.invocationId)
    return true
  }

  /** 恢复时重新取得运行租约；旧 park handle 只能消费一次。 */
  resumeLease(handle: ParkHandle): RuntimeLease | undefined {
    const current = this.parked.get(handle.invocationId)
    if (!current || current.runtimeId !== this.runtimeId || current.generation !== handle.generation) return undefined
    this.parked.delete(handle.invocationId)
    return this.acquireLease(handle.invocationId)
  }
}
