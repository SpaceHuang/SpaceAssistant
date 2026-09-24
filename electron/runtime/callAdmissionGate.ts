import { logAgentEvent } from '../agentLogger/agentLogger'
import type { AppDatabase } from '../database'
import {
  DEFAULT_ADMISSION_POLICY,
  applyAdmit,
  applyResume,
  applyRelease,
  emptyAdmissionState,
  judgeAdmission,
  judgeResumeAdmission,
  rollAdmissionWindow,
  HOUR_MS,
  type AdmissionPolicy,
  type AdmissionRequest,
  type AdmissionState
} from './callAdmission'
import { loadAdmissionState, resolveAdmissionPolicy, saveAdmissionState } from '../storage/callAdmissionStore'

/**
 * 调用级准入门(B1 0b,偏差 23):判定(纯函数)+ 状态(Storage)+ 排队唤醒 + 审计出口的组合。
 * - 四处发起入口(桌面受理端口 / 远端发起 / 管家发起 / 嵌套 invokeApproval)同一准入(评审 N2 口径);
 * - 排队语义:资源不足且调用方声明 queue 时入 FIFO 等待队列,释放时唤醒队首**重新判定**
 *   (票据计数不漂移——butlerAdmission 评审 P1 教训的机制化消除);
 * - 审计:拒绝必落 `admission.rejected`(cause=并发/速率/配额维度),排队/延后/降级落
 *   `admission.queued|deferred|degraded`——准入拒绝(资源)与裁决为否(agent-deny,confirmation
 *   审计体系)事件名分立,不得混计(基线 §7)。
 */

export type AdmissionTicket = {
  request: AdmissionRequest
  /** 返回 false 表示释放未完成，调用方仍可重试；票据不会被标记为已释放。 */
  release: () => boolean
}

export type ParkedAdmission = { request: AdmissionRequest; token: object }

/** release 幂等守卫(P2,评审):双释放会吞掉其他活跃调用的计数。 */
function onceRelease(request: AdmissionRequest, release: () => boolean | void): () => boolean {
  let released = false
  return () => {
    if (released) return true
    const committed = release()
    if (committed !== false) released = true
    return committed !== false
  }
}

export type AdmissionAcquireResult =
  | { ok: true; ticket: AdmissionTicket }
  | { ok: false; verdict: 'deferred' | 'degraded' }
  | { ok: false; verdict: 'rejected'; cause: string }

export type AdmissionResumeResult =
  | { ok: true; ticket: AdmissionTicket }
  | { ok: false; verdict: 'rejected'; cause: string; retryable: boolean }

type Waiter = { request: AdmissionRequest; resolve: (result: AdmissionAcquireResult) => void; onAbort?: () => void; cleanup?: () => void; sequence: number }
type ResumeWaiter = { handle: ParkedAdmission; resolve: (result: AdmissionResumeResult) => void; onAbort?: () => void; cleanup?: () => void; timer?: ReturnType<typeof setTimeout>; deadlineAt?: number; sequence: number }

export class CallAdmissionGate {
  private state: AdmissionState
  private readonly policy: AdmissionPolicy
  private readonly db: AppDatabase | null
  private readonly nowFn: () => number
  private readonly resumeTimeoutMs: number
  private readonly waiters: Waiter[] = []
  private readonly resumeWaiters: ResumeWaiter[] = []
  private readonly activeTickets = new WeakSet<AdmissionTicket>()
  private readonly parked = new Map<object, AdmissionRequest>()
  private readonly resumeInflight = new Map<object, Promise<AdmissionResumeResult>>()
  private readonly releaseRetries = new Map<AdmissionTicket, { timer: ReturnType<typeof setTimeout>; delayMs: number }>()
  private queueSequence = 0
  private wakeTimer: ReturnType<typeof setTimeout> | undefined

  private makeTicket(request: AdmissionRequest, apply: (request: AdmissionRequest) => boolean | void = (r) => this.release(r)): AdmissionTicket {
    let ticket!: AdmissionTicket
    ticket = {
      request,
      release: onceRelease(request, () => {
        const committed = apply(request)
        if (committed === false) this.scheduleReleaseRetry(ticket)
        else this.clearReleaseRetry(ticket)
        return committed
      })
    }
    this.activeTickets.add(ticket)
    return ticket
  }

  /**
   * 释放是同步 API，但持久化可能因 SQLITE_BUSY/SQLITE_FULL 暂时失败。
   * 票据必须由 gate 自己继续持有并重试，不能把恢复责任交给离开 finally 后
   * 已经丢失局部变量的业务调用方。timer unref 保证它不阻止应用退出。
   */
  private scheduleReleaseRetry(ticket: AdmissionTicket): void {
    if (this.releaseRetries.has(ticket)) return
    const schedule = (delayMs: number) => {
      const timer = setTimeout(() => {
        this.releaseRetries.delete(ticket)
        if (!this.activeTickets.has(ticket)) return
        if (!ticket.release()) schedule(Math.min(delayMs * 2, 5_000))
      }, delayMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.releaseRetries.set(ticket, { timer, delayMs })
    }
    schedule(25)
  }

  private clearReleaseRetry(ticket: AdmissionTicket): void {
    const retry = this.releaseRetries.get(ticket)
    if (!retry) return
    clearTimeout(retry.timer)
    this.releaseRetries.delete(ticket)
  }

  constructor(options: { db?: AppDatabase; policy?: AdmissionPolicy; now?: () => number; initialState?: AdmissionState; resumeTimeoutMs?: number } = {}) {
    this.db = options.db ?? null
    this.policy = options.policy ?? (options.db ? resolveAdmissionPolicy(options.db) : structuredClone(DEFAULT_ADMISSION_POLICY))
    this.nowFn = options.now ?? Date.now
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 30_000
    if (!Number.isFinite(this.resumeTimeoutMs) || this.resumeTimeoutMs <= 0) throw new Error('resumeTimeoutMs must be positive')
    this.state = options.initialState ?? (options.db ? loadAdmissionState(options.db, this.nowFn()) : emptyAdmissionState(this.nowFn()))
  }

  get queuedCount(): number {
    return this.waiters.length + this.resumeWaiters.length
  }

  snapshotState(): AdmissionState {
    return this.state
  }

  /** 判定 + 占位(即时判定与队列唤醒复核共用)。返回 null = 应排队。 */
  private tryAdmit(request: AdmissionRequest): AdmissionAcquireResult | null {
    const previousState = this.state
    // P1-2(评审):滚动结果必须写回状态——只在副本上判定会让 windowStart 永不前进,
    // 跨过首个小时边界后速率/配额限流永久失效
    this.state = rollAdmissionWindow(this.state, this.nowFn())
    const verdict = judgeAdmission(request, this.state, this.policy, this.nowFn())
    switch (verdict.verdict) {
      case 'admit': {
        this.state = applyAdmit(this.state, request)
        this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
        try {
          this.persist()
        } catch {
          this.state = previousState
          return { ok: false, verdict: 'rejected', cause: 'persistence-failed' }
        }
        return { ok: true, ticket: this.makeTicket(request) }
      }
      case 'queue':
        if (this.queuedCount >= this.policy.queueLimit) {
          this.auditEvent('admission.rejected', request, { cause: 'queue-full' }, 'warn')
          return { ok: false, verdict: 'rejected', cause: 'queue-full' }
        }
        return null
      case 'defer':
        this.auditEvent('admission.deferred', request, {}, 'info')
        return { ok: false, verdict: 'deferred' }
      case 'degrade':
        this.auditEvent('admission.degraded', request, {}, 'info')
        return { ok: false, verdict: 'degraded' }
      case 'reject':
        this.auditEvent('admission.rejected', request, { cause: verdict.cause }, 'warn')
        return { ok: false, verdict: 'rejected', cause: verdict.cause }
    }
  }

  /** 请求准入;资源不足且声明 queue 时挂起等待(释放时队首复核唤醒)。 */
  async acquire(request: AdmissionRequest, options: { signal?: AbortSignal } = {}): Promise<AdmissionAcquireResult> {
    if (options.signal?.aborted) return { ok: false, verdict: 'rejected', cause: 'cancelled' }
    const immediate = this.tryAdmit(request)
    if (immediate) return immediate

    this.auditEvent('admission.queued', request, { queued: this.waiters.length + 1 }, 'info')
    return new Promise<AdmissionAcquireResult>((resolve) => {
      const previousState = this.state
      const waiter: Waiter = { request, resolve, sequence: ++this.queueSequence }
      const cancel = () => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1)
        waiter.cleanup?.()
        this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
        try { this.persist() } catch { /* 取消已在内存中结算；持久化失败不得让调用永久挂起。 */ }
        resolve({ ok: false, verdict: 'rejected', cause: 'cancelled' })
      }
      waiter.onAbort = cancel
      if (options.signal) waiter.cleanup = () => options.signal!.removeEventListener('abort', cancel)
      if (options.signal?.aborted) { cancel(); return }
      options.signal?.addEventListener('abort', cancel, { once: true })
      this.waiters.push(waiter)
      this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
      try {
        this.persist()
      } catch (error) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.cleanup?.()
        this.state = previousState
        resolve({ ok: false, verdict: 'rejected', cause: 'persistence-failed' })
        return
      }
      this.scheduleWake()
    })
  }

  /** 释放票据并唤醒队首复核(复核不通过则队尾重排,等后续释放——计数不漂移)。 */
  release(request: AdmissionRequest): boolean {
    const previousState = this.state
    this.state = applyRelease(this.state, request)
    try {
      // 释放先完成持久化提交，再唤醒后继请求。持久化失败时恢复内存快照，
      // 让磁盘上的 active/hourly 计数与内存保持一致，并保留票据供调用方重试。
      this.persist()
    } catch {
      this.state = previousState
      return false
    }
    this.wakeNext()
    return true
  }

  cancel(requestId: string): boolean {
    let cancelled = false
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!
      if (waiter.request.requestId !== requestId) continue
      this.waiters.splice(index, 1)
      waiter.cleanup?.()
      waiter.resolve({ ok: false, verdict: 'rejected', cause: 'cancelled' })
      cancelled = true
    }
    this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
    if (cancelled) {
      try { this.persist() } catch { /* 内存 waiter 已确定性移除；下次持久化会覆盖 queued 快照。 */ }
    }
    return cancelled
  }
  private wakeNext(): void {
    // 普通请求与恢复请求必须共享一个按到达序排序的候选视图。
    // 逐个跳过当前 lane 不可准入的候选，不能先批量扫描普通队列再扫描恢复队列，
    // 否则后到的普通请求会越过较早但当前可恢复的请求。
    const candidates = [
      ...this.waiters.map((waiter) => ({ kind: 'normal' as const, sequence: waiter.sequence, waiter })),
      ...this.resumeWaiters.map((resumed) => ({ kind: 'resume' as const, sequence: resumed.sequence, resumed }))
    ].sort((a, b) => a.sequence - b.sequence)
    for (const candidate of candidates) {
      if (candidate.kind === 'normal') {
        const next = candidate.waiter
        if (!this.waiters.includes(next)) continue
        this.state = rollAdmissionWindow(this.state, this.nowFn())
        const verdict = judgeAdmission(next.request, this.state, this.policy, this.nowFn())
        if (verdict.verdict !== 'admit') continue
        const previousState = this.state
        const previousIndex = this.waiters.indexOf(next)
        this.waiters.splice(previousIndex, 1)
        this.state = applyAdmit(this.state, next.request)
        this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
        try {
          this.persist()
        } catch {
          this.state = previousState
          this.state = { ...this.state, queued: Math.max(0, this.state.queued - 1) }
          next.cleanup?.()
          next.resolve({ ok: false, verdict: 'rejected', cause: 'persistence-failed' })
          continue
        }
        next.cleanup?.()
        next.resolve({ ok: true, ticket: this.makeTicket(next.request) })
        continue
      }
      const resumed = candidate.resumed
      const index = this.resumeWaiters.indexOf(resumed)
      if (index < 0) continue
      const request = this.parked.get(resumed.handle.token)
      if (!request || request !== resumed.handle.request) {
        this.resumeWaiters.splice(index, 1)
        resumed.cleanup?.()
        if (resumed.timer) clearTimeout(resumed.timer)
          resumed.resolve({ ok: false, verdict: 'rejected', cause: 'stale-park-handle', retryable: false })
        continue
      }
      if (resumed.deadlineAt !== undefined && this.nowFn() >= resumed.deadlineAt) {
        this.resumeWaiters.splice(index, 1)
        resumed.cleanup?.()
        if (resumed.timer) clearTimeout(resumed.timer)
        this.parked.delete(resumed.handle.token)
        resumed.resolve({ ok: false, verdict: 'rejected', cause: 'resume-timeout', retryable: false })
        continue
      }
      this.state = rollAdmissionWindow(this.state, this.nowFn())
      const resumeVerdict = judgeResumeAdmission(request, this.state, this.policy)
      if (resumeVerdict.verdict === 'admit') {
        const previousState = this.state
        this.resumeWaiters.splice(index, 1)
        if (resumed.timer) clearTimeout(resumed.timer)
        resumed.cleanup?.()
        this.parked.delete(resumed.handle.token)
        this.state = applyResume(this.state, request)
        this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
        try {
          this.persist()
        } catch {
          this.state = { ...previousState, queued: Math.max(0, previousState.queued - 1) }
          this.parked.set(resumed.handle.token, request)
          resumed.resolve({ ok: false, verdict: 'rejected', cause: 'persistence-failed', retryable: true })
          continue
        }
        resumed.resolve({ ok: true, ticket: this.makeTicket(request) })
        continue
      }
    }
    if (this.waiters.length > 0 || this.resumeWaiters.length > 0) {
      this.scheduleWake()
    }
    this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
    try { this.persist() } catch { /* 唤醒结果已逐项结算，不能把已结算 promise 重新变成挂起。 */ }
  }

  private scheduleWake(): void {
    // 恢复队列也可能只受小时窗口阻塞；只检查普通队列会让已受理任务永久沉睡。
    if (this.wakeTimer || (this.waiters.length === 0 && this.resumeWaiters.length === 0)) return
    const delay = Math.max(1, this.state.windowStart + HOUR_MS - this.nowFn() + 1)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      this.state = rollAdmissionWindow(this.state, this.nowFn())
      this.wakeNext()
    }, delay)
    // 后台唤醒不应让测试或应用退出被悬挂的恢复请求阻塞。
    ;(this.wakeTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** 让出运行槽但保留已受理身份；恢复不增加小时启动计数。 */
  park(ticket: AdmissionTicket): ParkedAdmission | undefined {
    if (!this.activeTickets.has(ticket)) return undefined
    if (!ticket.release()) return undefined
    this.activeTickets.delete(ticket)
    const token = {}
    this.parked.set(token, ticket.request)
    return { request: ticket.request, token }
  }

  /** 终态恢复失败时显式消费 parked handle，避免调用方放弃句柄后留下进程内悬挂状态。 */
  discard(handle: ParkedAdmission): boolean {
    return this.parked.delete(handle.token)
  }

  resume(handle: ParkedAdmission, options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<AdmissionResumeResult> {
    const inflight = this.resumeInflight.get(handle.token)
    if (inflight) return inflight
    const operation = this.resumeInternal(handle, options)
    this.resumeInflight.set(handle.token, operation)
    void operation.then(() => this.resumeInflight.delete(handle.token), () => this.resumeInflight.delete(handle.token))
    return operation
  }

  private async resumeInternal(handle: ParkedAdmission, options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<AdmissionResumeResult> {
    const request = this.parked.get(handle.token)
    if (!request || request !== handle.request) return { ok: false, verdict: 'rejected', cause: 'stale-park-handle', retryable: false }
    if (options.signal?.aborted) {
      this.parked.delete(handle.token)
      return { ok: false, verdict: 'rejected', cause: 'cancelled', retryable: false }
    }
    if (options.deadlineAt !== undefined && this.nowFn() >= options.deadlineAt) {
      this.parked.delete(handle.token)
      return { ok: false, verdict: 'rejected', cause: 'resume-timeout', retryable: false }
    }
    this.state = rollAdmissionWindow(this.state, this.nowFn())
    const verdict = judgeResumeAdmission(request, this.state, this.policy)
    if (verdict.verdict !== 'admit') {
      if (this.queuedCount >= this.policy.queueLimit) {
        this.parked.delete(handle.token)
        this.auditEvent('admission.rejected', request, { cause: 'queue-full' }, 'warn')
        return { ok: false, verdict: 'rejected', cause: 'queue-full', retryable: false }
      }
      return new Promise<AdmissionResumeResult>((resolve) => {
        const previousState = this.state
        const waiter: ResumeWaiter = { handle, resolve, deadlineAt: options.deadlineAt, sequence: ++this.queueSequence }
        const cancel = () => {
          const index = this.resumeWaiters.indexOf(waiter)
          if (index < 0) return
        this.resumeWaiters.splice(index, 1)
        waiter.cleanup?.()
        if (waiter.timer) clearTimeout(waiter.timer)
          this.parked.delete(handle.token)
          this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
          try { this.persist() } catch { /* 恢复取消已结算；不能把异常传播进 AbortSignal 回调。 */ }
          resolve({ ok: false, verdict: 'rejected', cause: 'cancelled', retryable: false })
        }
        waiter.onAbort = cancel
        if (options.signal) waiter.cleanup = () => options.signal!.removeEventListener('abort', cancel)
        const remaining = options.deadlineAt === undefined
          ? this.resumeTimeoutMs
          : Math.min(this.resumeTimeoutMs, Math.max(1, options.deadlineAt - this.nowFn()))
        waiter.timer = setTimeout(() => {
          const index = this.resumeWaiters.indexOf(waiter)
          if (index < 0) return
          this.resumeWaiters.splice(index, 1)
          waiter.cleanup?.()
          this.parked.delete(handle.token)
          this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
          try { this.persist() } catch { /* 超时已结算；不能因持久化异常留下悬挂 Promise。 */ }
          resolve({ ok: false, verdict: 'rejected', cause: 'resume-timeout', retryable: false })
        }, remaining)
        ;(waiter.timer as unknown as { unref?: () => void }).unref?.()
        if (options.signal?.aborted) { cancel(); return }
        options.signal?.addEventListener('abort', cancel, { once: true })
        this.resumeWaiters.push(waiter)
        this.state = { ...this.state, queued: this.waiters.length + this.resumeWaiters.length }
        try {
          this.persist()
        } catch {
          const index = this.resumeWaiters.indexOf(waiter)
          if (index >= 0) this.resumeWaiters.splice(index, 1)
          if (waiter.timer) clearTimeout(waiter.timer)
          waiter.cleanup?.()
          this.parked.delete(handle.token)
          this.state = previousState
          resolve({ ok: false, verdict: 'rejected', cause: 'persistence-failed', retryable: false })
        }
      })
    }
    const previousState = this.state
    this.state = applyResume(this.state, request)
    try {
      this.persist()
    } catch {
      this.state = previousState
      this.parked.set(handle.token, request)
      return { ok: false, verdict: 'rejected', cause: 'persistence-failed', retryable: true }
    }
    this.parked.delete(handle.token)
    return { ok: true, ticket: this.makeTicket(request) }
  }

  private auditEvent(
    event: 'admission.rejected' | 'admission.queued' | 'admission.deferred' | 'admission.degraded',
    request: AdmissionRequest,
    fields: Record<string, unknown>,
    level: 'warn' | 'info'
  ): void {
    logAgentEvent(level, event, {
      requestId: request.requestId,
      lane: request.lane,
      priority: request.priority,
      role: request.role,
      disposition: request.disposition,
      ...fields
    })
  }

  private persist(): void {
    if (this.db) saveAdmissionState(this.db, this.state)
  }
}

// ---- 默认 gate 槽位(准入状态是唯一合法的跨调用全局态,且归 Storage;§5 纪律 4)----

let defaultGate: CallAdmissionGate | null = null

/** 默认准入门(main.ts 以 db 装配;未装配宿主/测试惰性建无库门)。 */
export function getCallAdmissionGate(): CallAdmissionGate {
  return defaultGate ??= new CallAdmissionGate()
}

export function setCallAdmissionGate(gate: CallAdmissionGate | null): void {
  defaultGate = gate
}
