import { logAgentEvent } from '../agentLogger/agentLogger'
import type { AppDatabase } from '../database'
import {
  DEFAULT_ADMISSION_POLICY,
  applyAdmit,
  applyRelease,
  emptyAdmissionState,
  judgeAdmission,
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
  release: () => void
}

export type AdmissionAcquireResult =
  | { ok: true; ticket: AdmissionTicket }
  | { ok: false; verdict: 'deferred' | 'degraded' }
  | { ok: false; verdict: 'rejected'; cause: string }

type Waiter = { request: AdmissionRequest; resolve: (result: AdmissionAcquireResult) => void }

export class CallAdmissionGate {
  private state: AdmissionState
  private readonly policy: AdmissionPolicy
  private readonly db: AppDatabase | null
  private readonly nowFn: () => number
  private readonly waiters: Waiter[] = []

  constructor(options: { db?: AppDatabase; policy?: AdmissionPolicy; now?: () => number; initialState?: AdmissionState } = {}) {
    this.db = options.db ?? null
    this.policy = options.policy ?? (options.db ? resolveAdmissionPolicy(options.db) : structuredClone(DEFAULT_ADMISSION_POLICY))
    this.nowFn = options.now ?? Date.now
    this.state = options.initialState ?? (options.db ? loadAdmissionState(options.db, this.nowFn()) : emptyAdmissionState(this.nowFn()))
  }

  get queuedCount(): number {
    return this.waiters.length
  }

  snapshotState(): AdmissionState {
    return this.state
  }

  /** 判定 + 占位(即时判定与队列唤醒复核共用)。返回 null = 应排队。 */
  private tryAdmit(request: AdmissionRequest): AdmissionAcquireResult | null {
    const verdict = judgeAdmission(request, this.state, this.policy, this.nowFn())
    switch (verdict.verdict) {
      case 'admit': {
        this.state = applyAdmit(this.state, request)
        this.persist()
        return { ok: true, ticket: { request, release: () => this.release(request) } }
      }
      case 'queue':
        if (this.waiters.length >= this.policy.queueLimit) {
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
  async acquire(request: AdmissionRequest): Promise<AdmissionAcquireResult> {
    const immediate = this.tryAdmit(request)
    if (immediate) return immediate

    this.auditEvent('admission.queued', request, { queued: this.waiters.length + 1 }, 'info')
    return new Promise<AdmissionAcquireResult>((resolve) => {
      this.waiters.push({ request, resolve })
      this.state = { ...this.state, queued: this.waiters.length }
      this.persist()
    })
  }

  /** 释放票据并唤醒队首复核(复核不通过则队尾重排,等后续释放——计数不漂移)。 */
  release(request: AdmissionRequest): void {
    this.state = applyRelease(this.state, request)
    this.wakeNext()
  }

  private wakeNext(): void {
    const next = this.waiters.shift()
    if (!next) {
      this.state = { ...this.state, queued: 0 }
      this.persist()
      return
    }
    const verdict = judgeAdmission(next.request, this.state, this.policy, this.nowFn())
    if (verdict.verdict === 'admit') {
      this.state = applyAdmit(this.state, next.request)
      this.persist()
      next.resolve({ ok: true, ticket: { request: next.request, release: () => this.release(next.request) } })
    } else {
      // 队首仍不足(如 lane 配额未随该次释放恢复):队尾重排,等待后续释放
      this.waiters.push(next)
      this.state = { ...this.state, queued: this.waiters.length }
      this.persist()
    }
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
