import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { openSqliteDatabase } from '../database/sqliteStore'
import { setConfigValue } from '../database/operations'
import {
  DEFAULT_ADMISSION_POLICY,
  applyAdmit,
  applyRelease,
  emptyAdmissionState,
  judgeAdmission,
  judgeResumeAdmission,
  rollAdmissionWindow,
  type AdmissionPolicy,
  type AdmissionRequest,
  type AdmissionState
} from './callAdmission'
import { CallAdmissionGate, setCallAdmissionGate } from './callAdmissionGate'
import {
  loadAdmissionState,
  resetActiveAdmissionOnStartup,
  resolveAdmissionPolicy,
  saveAdmissionState
} from '../storage/callAdmissionStore'
import * as agentLoggerModule from '../agentLogger/agentLogger'
import * as admissionStoreModule from '../storage/callAdmissionStore'

/** mulberry32(AGENTS.md 不变量测试纪律:确定性伪随机)。 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LANES = ['desktop', 'wechat', 'feishu', 'automation'] as const

function req(partial: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    lane: 'desktop',
    priority: 'interactive',
    role: 'top-level',
    disposition: 'queue',
    ...partial
  }
}

describe('judgeAdmission 判定纯函数(偏差 23 逐场景)', () => {
  it('空状态 + 容量内 → admit', () => {
    const state = emptyAdmissionState(1_000)
    expect(judgeAdmission(req(), state, DEFAULT_ADMISSION_POLICY, 1_000)).toEqual({ verdict: 'admit' })
  })

  it('全局并发满 → interactive 按 queue 处置排队;background 受子界约束(交互式优先)', () => {
    const policy: AdmissionPolicy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 2, backgroundMaxConcurrent: 1 }
    const full: AdmissionState = { ...emptyAdmissionState(0), activeInteractive: 2 }
    expect(judgeAdmission(req({ priority: 'interactive' }), full, policy, 0)).toEqual({ verdict: 'queue' })
    expect(judgeAdmission(req({ priority: 'background', disposition: 'reject' }), full, policy, 0)).toEqual({ verdict: 'reject', cause: 'concurrency-cap' })
    // background 子界:全局未满但 background 满 → background 不可入,interactive 可入
    const bgFull: AdmissionState = { ...emptyAdmissionState(0), activeBackground: 1 }
    expect(judgeAdmission(req({ priority: 'background', disposition: 'reject' }), bgFull, policy, 0)).toEqual({ verdict: 'reject', cause: 'concurrency-cap' })
    expect(judgeAdmission(req({ priority: 'interactive' }), bgFull, policy, 0)).toEqual({ verdict: 'admit' })
  })

  it('审批回答者保留位:interactive 满 → 顶层排队,回答者(继承 interactive)凭保留位准入', () => {
    const policy: AdmissionPolicy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 2, approvalReservedSlots: 1 }
    const full: AdmissionState = { ...emptyAdmissionState(0), activeInteractive: 2 }
    expect(judgeAdmission(req({ role: 'top-level' }), full, policy, 0)).toEqual({ verdict: 'queue' })
    expect(judgeAdmission(req({ role: 'approval-answerer', disposition: 'reject' }), full, policy, 0)).toEqual({ verdict: 'admit' })
    // 保留位也有上限:max + reserved
    const overFull: AdmissionState = { ...emptyAdmissionState(0), activeInteractive: 3 }
    expect(judgeAdmission(req({ role: 'approval-answerer', disposition: 'reject' }), overFull, policy, 0)).toEqual({ verdict: 'reject', cause: 'concurrency-cap' })
  })

  it('速率与 lane 配额:超每小时启动上限按处置映射;窗口滚动重置', () => {
    const policy: AdmissionPolicy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalHourlyStarts: 5 }
    const state: AdmissionState = { ...emptyAdmissionState(0), windowStarts: 5 }
    expect(judgeAdmission(req({ disposition: 'reject' }), state, policy, 1000)).toEqual({ verdict: 'reject', cause: 'rate-limit' })
    expect(judgeAdmission(req({ disposition: 'defer' }), state, policy, 1000)).toEqual({ verdict: 'defer' })
    expect(judgeAdmission(req({ disposition: 'degrade' }), state, policy, 1000)).toEqual({ verdict: 'degrade' })
    // 窗口外 → 重置后放行
    expect(judgeAdmission(req({ disposition: 'reject' }), state, policy, 3_600_000)).toEqual({ verdict: 'admit' })
  })

  it('lane 并发配额独立于全局', () => {
    const policy: AdmissionPolicy = structuredClone(DEFAULT_ADMISSION_POLICY)
    const state: AdmissionState = { ...emptyAdmissionState(0), laneActive: { ...emptyAdmissionState(0).laneActive, automation: 1 } }
    expect(judgeAdmission(req({ lane: 'automation', disposition: 'reject' }), state, policy, 0)).toEqual({ verdict: 'reject', cause: 'lane-concurrency-cap' })
    expect(judgeAdmission(req({ lane: 'desktop', disposition: 'reject' }), state, policy, 0)).toEqual({ verdict: 'admit' })
  })

  it('applyAdmit/applyRelease 计数守恒(含 lane 维度)', () => {
    let state = emptyAdmissionState(0)
    const r1 = req({ lane: 'wechat' })
    const r2 = req({ priority: 'background', lane: 'automation' })
    state = applyAdmit(state, r1)
    state = applyAdmit(state, r2)
    expect(state.activeInteractive).toBe(1)
    expect(state.activeBackground).toBe(1)
    expect(state.laneActive.automation).toBe(1)
    expect(state.windowStarts).toBe(2)
    state = applyRelease(state, r1)
    state = applyRelease(state, r2)
    expect(state.activeInteractive).toBe(0)
    expect(state.activeBackground).toBe(0)
    expect(state.laneActive.automation).toBe(0)
  })

  it('rollAdmissionWindow 纯滚动', () => {
    const state = { ...emptyAdmissionState(0), windowStarts: 9 }
    const rolled = rollAdmissionWindow(state, 3_600_000)
    expect(rolled.windowStarts).toBe(0)
    expect(rolled.windowStart).toBe(3_600_000)
    expect(state.windowStarts).toBe(9)
  })
})

describe('CallAdmissionGate 普通队列取消', () => {
  it('取消信号触发后移除普通 waiter，释放槽位不得启动已取消请求', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1, queueLimit: 4 } })
    const first = await gate.acquire(req({ requestId: 'first' }))
    expect(first.ok).toBe(true)
    const controller = new AbortController()
    const queued = gate.acquire(req({ requestId: 'cancelled' }), { signal: controller.signal })
    controller.abort()
    await expect(queued).resolves.toMatchObject({ ok: false, cause: 'cancelled' })
    expect(gate.queuedCount).toBe(0)
    first.ok && first.ticket.release()
    expect(gate.snapshotState().activeInteractive).toBe(0)
  })
})

describe('judgeAdmission 属性/不变量(偏差 23 验收;mulberry32 随机操作序列)', () => {
  it('随机 acquire/release 序列:每步不变量——已发票据守恒、上界不被突破、lane 配额不越界', () => {
    const rand = mulberry32(20260920)
    const policy: AdmissionPolicy = {
      ...structuredClone(DEFAULT_ADMISSION_POLICY),
      globalMaxConcurrent: 4,
      backgroundMaxConcurrent: 2,
      laneMaxConcurrent: { desktop: 2, wechat: 2, feishu: 1, automation: 1 },
      globalHourlyStarts: 50,
      laneHourlyStarts: { desktop: 50, wechat: 50, feishu: 50, automation: 50 }
    }
    let state = emptyAdmissionState(0)
    const outstanding: AdmissionRequest[] = []
    let admittedThroughGate = 0
    for (let step = 0; step < 2000; step++) {
      const roll = rand()
      const lane = LANES[Math.floor(rand() * LANES.length)]
      const priority = rand() < 0.7 ? 'interactive' : 'background'
      const role = rand() < 0.15 ? 'approval-answerer' : 'top-level'
      if (roll < 0.55 || outstanding.length === 0) {
        const request = req({ lane, priority, role })
        const verdict = judgeAdmission(request, state, policy, 0)
        if (verdict.verdict === 'admit') {
          state = applyAdmit(state, request)
          outstanding.push(request)
          admittedThroughGate += 1
        }
      } else {
        const idx = Math.floor(rand() * outstanding.length)
        const released = outstanding.splice(idx, 1)[0]
        state = applyRelease(state, released)
      }
      // 不变量(每步断言);保留位放宽按 outstanding 实际构成计(存在 interactive 回答者时 +reserved)
      const total = state.activeInteractive + state.activeBackground
      const globalCeiling = policy.globalMaxConcurrent + (outstanding.some((o) => o.role === 'approval-answerer' && o.priority === 'interactive') ? policy.approvalReservedSlots : 0)
      expect(total, `step ${step}: 全局活跃 ≤ 上界`).toBeLessThanOrEqual(globalCeiling)
      expect(state.activeBackground, `step ${step}: background ≤ 子界`).toBeLessThanOrEqual(policy.backgroundMaxConcurrent)
      for (const lane of LANES) {
        // 保留位放宽:outstanding 中该 lane 存在审批回答者时,上界 = 配额 + reserved(防自锁的合法越配额)
        const hasApprovalAnswerer = outstanding.some((o) => o.lane === lane && o.role === 'approval-answerer')
        const laneCeiling = policy.laneMaxConcurrent[lane] + (hasApprovalAnswerer ? policy.approvalReservedSlots : 0)
        expect(state.laneActive[lane], `step ${step}: lane ${lane} 活跃 ≤ 配额${hasApprovalAnswerer ? '+保留位' : ''}`).toBeLessThanOrEqual(laneCeiling)
        expect(state.laneActive[lane]).toBeGreaterThanOrEqual(0)
      }
      expect(total).toBe(outstanding.length)
      expect(state.windowStarts).toBeLessThanOrEqual(policy.globalHourlyStarts + outstanding.length)
    }
    expect(admittedThroughGate).toBeGreaterThan(0)
  })

  it('保留位防自锁属性:N 条并发各等裁决时,审批回答者至少有一条能拿到位', () => {
    const policy: AdmissionPolicy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 3, approvalReservedSlots: 1 }
    let state = emptyAdmissionState(0)
    // 3 条顶层 interactive 全部占位
    for (let i = 0; i < 3; i++) {
      const verdict = judgeAdmission(req({}), state, policy, 0)
      expect(verdict.verdict).toBe('admit')
      state = applyAdmit(state, req({}))
    }
    // 顶层第 4 条被限
    expect(judgeAdmission(req({}), state, policy, 0).verdict).toBe('queue')
    // 回答者仍能拿到位(防 N 条互锁自锁)
    expect(judgeAdmission(req({ role: 'approval-answerer', disposition: 'reject' }), state, policy, 0)).toEqual({ verdict: 'admit' })
  })

  it('保留位防自锁(lane 维度):等待方持满 automation lane 票据,审批回答者仍可准入', () => {
    const policy: AdmissionPolicy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), laneMaxConcurrent: { ...DEFAULT_ADMISSION_POLICY.laneMaxConcurrent, automation: 1 } }
    let state = emptyAdmissionState(0)
    state = applyAdmit(state, req({ lane: 'automation', priority: 'background' }))
    // 顶层 automation 第 2 条被 lane 配额限
    expect(judgeAdmission(req({ lane: 'automation', priority: 'background', disposition: 'reject' }), state, policy, 0)).toEqual({ verdict: 'reject', cause: 'lane-concurrency-cap' })
    // 外层管家等裁决 → 内层审批回答者(automation 域)凭保留位准入(自锁回旋)
    expect(judgeAdmission(req({ lane: 'automation', priority: 'interactive', role: 'approval-answerer', disposition: 'reject' }), state, policy, 0)).toEqual({ verdict: 'admit' })
  })
})

describe('CallAdmissionGate 排队唤醒与审计(0b 语义)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(agentLoggerModule, 'logAgentEvent').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    setCallAdmissionGate(null)
  })

  it('并发满 → disposition=queue 排队等待;释放后队首复核唤醒', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'r1' }))
    expect(first.ok).toBe(true)
    const pending = gate.acquire(req({ requestId: 'r2', disposition: 'queue' }))
    // 让 promise 挂起进入队列
    await Promise.resolve()
    expect(gate.queuedCount).toBe(1)
    first.ok && first.ticket.release()
    const second = await pending
    expect(second.ok).toBe(true)
    second.ok && second.ticket.release()
  })

  it('队列满 → reject queue-full(不静默丢弃)', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1, queueLimit: 1 } })
    const first = await gate.acquire(req({ requestId: 'r1' }))
    expect(first.ok).toBe(true)
    const pending = gate.acquire(req({ requestId: 'r2' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(gate.queuedCount).toBe(1)
    const third = await gate.acquire(req({ requestId: 'r3' }))
    expect(third).toEqual({ ok: false, verdict: 'rejected', cause: 'queue-full' })
    expect(warnSpy).toHaveBeenCalledWith('warn', 'admission.rejected', expect.objectContaining({ cause: 'queue-full', requestId: 'r3' }))
    // 收尾:释放并排空队列,避免悬挂 promise
    first.ok && first.ticket.release()
    const drained = await pending
    drained.ok && drained.ticket.release()
  })

  it('cause 分立:准入拒绝事件 admission.rejected(cause=资源维度),与裁决 agent-deny 无交集', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'r1' }))
    expect(first.ok).toBe(true)
    const denied = await gate.acquire(req({ requestId: 'r2', disposition: 'reject' }))
    expect(denied).toEqual({ ok: false, verdict: 'rejected', cause: 'concurrency-cap' })
    expect(warnSpy).toHaveBeenCalledWith('warn', 'admission.rejected', expect.objectContaining({ cause: 'concurrency-cap' }))
    // 分立断言:准入事件名集合不含 agent-deny 字样;裁决否走 confirmation 体系(confirm.outcome)
    for (const call of warnSpy.mock.calls) {
      expect(String(call[1])).not.toContain('agent-deny')
    }
    first.ok && first.ticket.release()
  })
})

describe('CallAdmissionGate 持久化失败收敛', () => {
  it('释放持久化失败时恢复内存状态，重试成功后才释放票据', async () => {
    const db = openSqliteDatabase(':memory:')
    const gate = new CallAdmissionGate({ db, policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'release-persist-first' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return db.close()

    const persist = vi.spyOn(admissionStoreModule, 'saveAdmissionState').mockImplementation(() => { throw new Error('db-full') })
    expect(first.ticket.release()).toBe(false)
    expect(gate.snapshotState().activeInteractive).toBe(1)
    expect(loadAdmissionState(db, Date.now()).activeInteractive).toBe(1)
    const reloadedWhileDirty = new CallAdmissionGate({ db, policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    await expect(reloadedWhileDirty.acquire(req({ requestId: 'release-persist-reload-blocked', disposition: 'reject' })))
      .resolves.toMatchObject({ ok: false, verdict: 'rejected', cause: 'concurrency-cap' })

    persist.mockRestore()
    await vi.waitFor(() => expect(loadAdmissionState(db, Date.now()).activeInteractive).toBe(0), { timeout: 1_000 })
    expect(gate.snapshotState().activeInteractive).toBe(0)
    const reloadedAfterCommit = new CallAdmissionGate({ db, policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const admittedAfterCommit = await reloadedAfterCommit.acquire(req({ requestId: 'release-persist-reload-open', disposition: 'reject' }))
    expect(admittedAfterCommit.ok).toBe(true)
    if (admittedAfterCommit.ok) admittedAfterCommit.ticket.release()
    db.close()
  })

  it('普通排队持久化失败不会留下幽灵 waiter 或 queued 计数', async () => {
    const db = openSqliteDatabase(':memory:')
    const firstGate = new CallAdmissionGate({ db, policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await firstGate.acquire(req({ requestId: 'persist-first' }))
    expect(first.ok).toBe(true)
    const persist = vi.spyOn(admissionStoreModule, 'saveAdmissionState').mockImplementation(() => { throw new Error('db-full') })
    const queued = await firstGate.acquire(req({ requestId: 'persist-queued' }))
    expect(queued).toEqual({ ok: false, verdict: 'rejected', cause: 'persistence-failed' })
    expect(firstGate.queuedCount).toBe(0)
    expect(firstGate.snapshotState().queued).toBe(0)
    persist.mockRestore()
    db.close()
  })

  it('恢复持久化首次失败会保留 parked handle，第二次成功后无悬挂句柄', async () => {
    const db = openSqliteDatabase(':memory:')
    const gate = new CallAdmissionGate({ db, policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'persist-parked' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return db.close()
    const parked = gate.park(first.ticket)
    expect(parked).toBeDefined()
    const blocker = await gate.acquire(req({ requestId: 'persist-blocker' }))
    expect(blocker.ok).toBe(true)
    blocker.ok && blocker.ticket.release()
    const persist = vi.spyOn(admissionStoreModule, 'saveAdmissionState').mockImplementation(() => { throw new Error('db-full') })
    const resumed = await gate.resume(parked!)
    expect(resumed).toEqual({ ok: false, verdict: 'rejected', cause: 'persistence-failed', retryable: true })
    expect(gate.queuedCount).toBe(0)
    persist.mockRestore()
    const resumedAgain = await gate.resume(parked!)
    expect(resumedAgain).toMatchObject({ ok: true })
    if (resumedAgain.ok) resumedAgain.ticket.release()
    db.close()
  })

  it('显式 cancel 终结普通 waiter 时移除 AbortSignal listener', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'listener-first' }))
    expect(first.ok).toBe(true)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = gate.acquire(req({ requestId: 'listener-queued' }), { signal: controller.signal })
    await Promise.resolve()
    expect(gate.cancel('listener-queued')).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: false, cause: 'cancelled' })
    expect(remove).toHaveBeenCalled()
    first.ok && first.ticket.release()
  })

  it('恢复 waiter 成功唤醒时移除 AbortSignal listener', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'resume-listener-first' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const parked = gate.park(first.ticket)!
    const blocker = await gate.acquire(req({ requestId: 'resume-listener-blocker' }))
    expect(blocker.ok).toBe(true)
    if (!blocker.ok) return
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = gate.resume(parked, { signal: controller.signal })
    blocker.ticket.release()
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(remove).toHaveBeenCalled()
  })

  it('恢复 waiter 超时终结时移除 AbortSignal listener', async () => {
    vi.useFakeTimers()
    try {
      const gate = new CallAdmissionGate({
        resumeTimeoutMs: 50,
        policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 }
      })
      const first = await gate.acquire(req({ requestId: 'resume-timeout-listener-first' }))
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const parked = gate.park(first.ticket)!
      const blocker = await gate.acquire(req({ requestId: 'resume-timeout-listener-blocker' }))
      expect(blocker.ok).toBe(true)
      if (!blocker.ok) return
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const pending = gate.resume(parked, { signal: controller.signal })
      await vi.advanceTimersByTimeAsync(51)
      await expect(pending).resolves.toMatchObject({ ok: false, cause: 'resume-timeout' })
      expect(remove).toHaveBeenCalled()
      blocker.ticket.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('普通 waiter 取消时持久化失败也必须结算，不得永久挂起', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'cancel-persist-first' }))
    expect(first.ok).toBe(true)
    const pending = gate.acquire(req({ requestId: 'cancel-persist-queued' }))
    await Promise.resolve()
    const persist = vi.spyOn(admissionStoreModule, 'saveAdmissionState').mockImplementation(() => { throw new Error('db-full') })

    const controller = new AbortController()
    const queued = gate.acquire(req({ requestId: 'cancel-persist-abort' }), { signal: controller.signal })
    controller.abort()

    await expect(queued).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'cancelled' })
    gate.cancel('cancel-persist-queued')
    await expect(pending).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'cancelled' })
    persist.mockRestore()
    if (first.ok) first.ticket.release()
  })

  it('恢复 waiter 取消或超时时持久化失败也必须结算', async () => {
    const gate = new CallAdmissionGate({
      policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 },
      resumeTimeoutMs: 10
    })
    const first = await gate.acquire(req({ requestId: 'resume-persist-first' }))
    expect(first.ok).toBe(true)
    const parked = first.ok ? gate.park(first.ticket) : undefined
    expect(parked).toBeDefined()
    const blocker = await gate.acquire(req({ requestId: 'resume-persist-blocker' }))
    expect(blocker.ok).toBe(true)
    const persist = vi.spyOn(admissionStoreModule, 'saveAdmissionState').mockImplementation(() => { throw new Error('db-full') })

    const controller = new AbortController()
    const cancelled = gate.resume(parked!, { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(cancelled).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'cancelled', retryable: false })

    persist.mockRestore()
    if (blocker.ok) blocker.ticket.release()
    const second = await gate.acquire(req({ requestId: 'resume-persist-second' }))
    const secondParked = second.ok ? gate.park(second.ticket) : undefined
    expect(secondParked).toBeDefined()
    const secondBlocker = await gate.acquire(req({ requestId: 'resume-persist-second-blocker' }))
    expect(secondBlocker.ok).toBe(true)
    const timeoutPersist = vi.spyOn(admissionStoreModule, 'saveAdmissionState').mockImplementation(() => { throw new Error('db-full') })
    const timedOut = gate.resume(secondParked!)
    await expect(timedOut).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'resume-timeout', retryable: false })
    timeoutPersist.mockRestore()
    if (secondBlocker.ok) secondBlocker.ticket.release()
  })

  it('唤醒阶段持久化失败不抛出且不留下幽灵 waiter', async () => {
    const db = openSqliteDatabase(':memory:')
    const gate = new CallAdmissionGate({ db, policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'wake-persist-first' }))
    expect(first.ok).toBe(true)
    const queued = gate.acquire(req({ requestId: 'wake-persist-queued' }))
    await Promise.resolve()
    let persistCalls = 0
    const persist = vi.spyOn(admissionStoreModule, 'saveAdmissionState').mockImplementation(() => {
      persistCalls += 1
      if (persistCalls >= 2) throw new Error('db-full')
    })
    expect(() => { if (first.ok) expect(first.ticket.release()).toBe(true) }).not.toThrow()
    await expect(queued).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'persistence-failed' })
    expect(gate.queuedCount).toBe(0)
    persist.mockRestore()
    db.close()
  })
})

describe('CallAdmissionGate park/resume（D2）', () => {
  it('恢复任务与普通任务共享有界队列容量并保持 queued 计数一致', async () => {
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 2, queueLimit: 1 }
    const gate = new CallAdmissionGate({ policy })
    const a = await gate.acquire(req({ requestId: 'park-a' }))
    const b = await gate.acquire(req({ requestId: 'park-b' }))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const parkedA = gate.park(a.ticket)!
    const parkedB = gate.park(b.ticket)!
    const blockerA = await gate.acquire(req({ requestId: 'blocker-a' }))
    const blockerB = await gate.acquire(req({ requestId: 'blocker-b' }))
    expect(blockerA.ok && blockerB.ok).toBe(true)
    const firstResume = gate.resume(parkedA)
    await Promise.resolve()
    expect(gate.snapshotState().queued).toBe(1)
    await expect(gate.resume(parkedB)).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'queue-full', retryable: false })
    expect(gate.queuedCount).toBe(1)
    if (blockerA.ok) blockerA.ticket.release()
    const restored = await firstResume
    expect(restored.ok).toBe(true)
    if (blockerB.ok) blockerB.ticket.release()
    if (restored.ok) restored.ticket.release()
  })

  it('让出运行槽后恢复不增加 hourly start 计数', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const admitted = await gate.acquire(req({ requestId: 'parked' }))
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const parked = gate.park(admitted.ticket)
    expect(parked).toBeDefined()
    expect(gate.snapshotState().activeInteractive).toBe(0)
    const resumed = await gate.resume(parked!)
    expect(resumed.ok).toBe(true)
    expect(gate.snapshotState().windowStarts).toBe(1)
    if (resumed.ok) resumed.ticket.release()
  })

  it('hourly quota exhausted but slot free: accepted task can resume without incrementing starts', async () => {
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalHourlyStarts: 1, laneHourlyStarts: { ...DEFAULT_ADMISSION_POLICY.laneHourlyStarts, desktop: 1 } }
    const initial = { ...emptyAdmissionState(0), windowStarts: 1, laneWindowStarts: { ...emptyAdmissionState(0).laneWindowStarts, desktop: 1 } }
    const request = req({ requestId: 'already-accepted', lane: 'desktop', disposition: 'reject' })
    expect(judgeAdmission(request, initial, policy, 0).verdict).toBe('reject')
    expect(judgeResumeAdmission(request, initial, policy)).toEqual({ verdict: 'admit' })
    const gate = new CallAdmissionGate({ policy, initialState: { ...initial, windowStarts: 0, laneWindowStarts: { ...initial.laneWindowStarts, desktop: 0 } } })
    const admitted = await gate.acquire(request)
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const parked = gate.park(admitted.ticket)
    expect(parked).toBeDefined()
    const liveState = gate.snapshotState()
    liveState.windowStarts = 1
    liveState.laneWindowStarts.desktop = 1
    const resumed = await gate.resume(parked!)
    expect(resumed.ok).toBe(true)
    expect(gate.snapshotState().windowStarts).toBe(1)
  })

  it('parked task waits behind a newly admitted task, then resumes before new waiters', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'parked-first' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const parked = gate.park(first.ticket)
    expect(parked).toBeDefined()
    const secondPending = gate.acquire(req({ requestId: 'new-second', disposition: 'queue' }))
    const second = await secondPending
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const resumedPending = gate.resume(parked!)
    let resumed = false
    void resumedPending.then(() => { resumed = true })
    await Promise.resolve()
    expect(resumed).toBe(false)
    second.ticket.release()
    const restored = await resumedPending
    expect(restored.ok).toBe(true)
    expect(gate.snapshotState().windowStarts).toBe(2)
    if (restored.ok) restored.ticket.release()
  })
})

describe('v5 恢复生命周期', () => {
  it('恢复等待超过 deadline 会失效 parked handle 且不永久挂起', async () => {
    const gate = new CallAdmissionGate({
      resumeTimeoutMs: 5,
      policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 }
    })
    const first = await gate.acquire(req({ requestId: 'timeout-source' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const parked = gate.park(first.ticket)!
    const blocker = await gate.acquire(req({ requestId: 'timeout-blocker' }))
    expect(blocker.ok).toBe(true)
    if (!blocker.ok) return
    await expect(gate.resume(parked)).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'resume-timeout', retryable: false })
    expect(gate.queuedCount).toBe(0)
    blocker.ticket.release()
    await expect(gate.resume(parked)).resolves.toMatchObject({ ok: false, cause: 'stale-park-handle' })
  })

  it('恢复前取消信号已触发时立即收敛且不残留句柄', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const admitted = await gate.acquire(req({ requestId: 'accepted' }))
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const parked = gate.park(admitted.ticket)!
    const controller = new AbortController()
    controller.abort()
    await expect(gate.resume(parked, { signal: controller.signal })).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'cancelled', retryable: false })
    await expect(gate.resume(parked)).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'stale-park-handle', retryable: false })
  })
  it('取消恢复等待会移除等待项并使句柄失效', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'running' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const parked = gate.park(first.ticket)!
    const blocker = await gate.acquire(req({ requestId: 'blocker' }))
    expect(blocker.ok).toBe(true)
    if (!blocker.ok) return
    const controller = new AbortController()
    const pending = gate.resume(parked, { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'cancelled', retryable: false })
    expect(gate.queuedCount).toBe(0)
    blocker.ticket.release()
    await expect(gate.resume(parked)).resolves.toEqual({ ok: false, verdict: 'rejected', cause: 'stale-park-handle', retryable: false })
  })

  it('恢复队首 lane 受阻时仍唤醒其他 lane 的可用恢复任务', async () => {
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 2, laneMaxConcurrent: { ...DEFAULT_ADMISSION_POLICY.laneMaxConcurrent, desktop: 1, automation: 1 } }
    const gate = new CallAdmissionGate({ policy })
    const a = await gate.acquire(req({ requestId: 'a', lane: 'desktop' }))
    const b = await gate.acquire(req({ requestId: 'b', lane: 'automation' }))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const parkedA = gate.park(a.ticket)!
    const parkedB = gate.park(b.ticket)!
    const a2 = await gate.acquire(req({ requestId: 'a2', lane: 'desktop' }))
    expect(a2.ok).toBe(true)
    if (!a2.ok) return
    const resumeA = gate.resume(parkedA)
    const resumeB = gate.resume(parkedB)
    b.ticket.release()
    await expect(resumeB).resolves.toMatchObject({ ok: true })
    expect(gate.queuedCount).toBe(1)
    a2.ticket.release()
    await expect(resumeA).resolves.toMatchObject({ ok: true })
  })

  it('恢复 lane 受阻时，其他 lane 的普通排队任务仍可使用空闲容量', async () => {
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 2, laneMaxConcurrent: { ...DEFAULT_ADMISSION_POLICY.laneMaxConcurrent, desktop: 1, automation: 1 } }
    const gate = new CallAdmissionGate({ policy })
    const a = await gate.acquire(req({ requestId: 'a', lane: 'desktop' }))
    const b = await gate.acquire(req({ requestId: 'b', lane: 'automation' }))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const parkedA = gate.park(a.ticket)!
    const a2 = await gate.acquire(req({ requestId: 'a2', lane: 'desktop' }))
    expect(a2.ok).toBe(true)
    if (!a2.ok) return
    const resumeA = gate.resume(parkedA)
    const b2Pending = gate.acquire(req({ requestId: 'b2', lane: 'automation', disposition: 'queue' }))
    b.ticket.release()
    const b2 = await b2Pending
    expect(b2.ok).toBe(true)
    if (b2.ok) b2.ticket.release()
    a2.ticket.release()
    await expect(resumeA).resolves.toMatchObject({ ok: true })
  })

  it('普通队列队首 lane 受阻时扫描后续 lane', async () => {
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 2, laneMaxConcurrent: { ...DEFAULT_ADMISSION_POLICY.laneMaxConcurrent, desktop: 1, automation: 1 } }
    const gate = new CallAdmissionGate({ policy })
    const a = await gate.acquire(req({ requestId: 'a', lane: 'desktop' }))
    const b = await gate.acquire(req({ requestId: 'b', lane: 'automation' }))
    if (!a.ok || !b.ok) return
    const a2 = gate.acquire(req({ requestId: 'a2', lane: 'desktop', disposition: 'queue' }))
    const b2 = gate.acquire(req({ requestId: 'b2', lane: 'automation', disposition: 'queue' }))
    b.ticket.release()
    const admittedB = await b2
    expect(admittedB.ok).toBe(true)
    a.ticket.release()
    if ((await a2).ok && admittedB.ok) admittedB.ticket.release()
  })

  it('小时配额窗口到期会唤醒排队请求', async () => {
    vi.useFakeTimers()
    try {
    let now = 0
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1, globalHourlyStarts: 1 }
    const gate = new CallAdmissionGate({ policy, now: () => now })
    const first = await gate.acquire(req({ requestId: 'first' }))
    if (!first.ok) return
    const pending = gate.acquire(req({ requestId: 'later', disposition: 'queue' }))
    first.ticket.release()
    now = 3_600_001
    await vi.advanceTimersByTimeAsync(3_600_001)
    const later = await pending
    expect(later.ok).toBe(true)
    if (later.ok) later.ticket.release()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('评审修复验收(P1-1 / P1-2)', () => {
  it('P1-1 脏活跃状态 db → new Gate:幻影票据不蚕食有效容量', async () => {
    const db = openSqliteDatabase(':memory:')
    // 上一进程遗留:活跃 2(全局上界 4)+ automation lane 满 1
    const dirty = emptyAdmissionState(0)
    saveAdmissionState(db, {
      ...dirty,
      activeInteractive: 2,
      laneActive: { ...dirty.laneActive, automation: 1 }
    })
    resetActiveAdmissionOnStartup(db, 1_000)
    const gate = new CallAdmissionGate({ db, now: () => 1_000 })
    // 修复前:gate 构造读入幻影票据,容量被蚕食/automation lane 直接拒
    const a = await gate.acquire(req({ requestId: 'a' }))
    expect(a.ok).toBe(true)
    const b = await gate.acquire(req({ lane: 'automation', priority: 'background', requestId: 'b' }))
    expect(b.ok).toBe(true)
    a.ok && a.ticket.release()
    b.ok && b.ticket.release()
  })

  it('P1-2 跨 HOUR 边界:速率窗口随滚动落状态,每小时内限流、跨窗重置', async () => {
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalHourlyStarts: 2, globalMaxConcurrent: 50 }
    let now = 0
    const gate = new CallAdmissionGate({ policy, now: () => now })
    const r1 = await gate.acquire(req({ requestId: 'r1' }))
    const r2 = await gate.acquire(req({ requestId: 'r2' }))
    expect(r1.ok && r2.ok).toBe(true)
    // 窗口内第 3 次:超每小时启动上限 → 拒绝(disposition=reject)
    const queued = await gate.acquire(req({ requestId: 'r3', disposition: 'reject' }))
    expect(queued).toEqual({ ok: false, verdict: 'rejected', cause: 'rate-limit' })
    // 跨窗口边界:滚动落状态 → 计数重置,重新放行
    now = 3_600_000
    const r4 = await gate.acquire(req({ requestId: 'r4', disposition: 'reject' }))
    expect(r4.ok).toBe(true)
    r4.ok && r4.ticket.release()
    r1.ok && r1.ticket.release()
    r2.ok && r2.ticket.release()
  })

  it('P1-2(管家 lane 配额维度)跨边界同样恢复', async () => {
    const policy = { ...structuredClone(DEFAULT_ADMISSION_POLICY), laneHourlyStarts: { ...DEFAULT_ADMISSION_POLICY.laneHourlyStarts, automation: 1 } }
    let now = 0
    const gate = new CallAdmissionGate({ policy, now: () => now })
    const first = await gate.acquire(req({ lane: 'automation', priority: 'background', disposition: 'reject', requestId: 'a1' }))
    if (!first.ok) console.error('[DEBUG a1]', JSON.stringify(first))
    expect(first.ok).toBe(true)
    const second = await gate.acquire(req({ lane: 'automation', priority: 'background', disposition: 'reject', requestId: 'a2' }))
    expect(second).toEqual({ ok: false, verdict: 'rejected', cause: 'lane-hourly-quota' })
    now = 3_600_000
    first.ok && first.ticket.release() // 释放并发位(验证的是配额窗口恢复,不并发占位)
    const third = await gate.acquire(req({ lane: 'automation', priority: 'background', disposition: 'reject', requestId: 'a3' }))
    expect(third.ok).toBe(true)
    third.ok && third.ticket.release()
  })

  it('ticket 双释放幂等(P2):第二次 release 不吞其他活跃调用计数', async () => {
    const gate = new CallAdmissionGate({ policy: { ...structuredClone(DEFAULT_ADMISSION_POLICY), globalMaxConcurrent: 1 } })
    const first = await gate.acquire(req({ requestId: 'r1' }))
    expect(first.ok).toBe(true)
    first.ok && first.ticket.release()
    first.ok && first.ticket.release() // 双释放
    const next = await gate.acquire(req({ requestId: 'r2', disposition: 'reject' }))
    expect(next.ok).toBe(true)
    next.ok && next.ticket.release()
  })
})

describe('Storage 状态(callAdmissionStore,偏差 23:准入状态归 Storage)', () => {
  it('状态持久化跨实例可读;启动维护清零活跃段、保留速率窗口计数', () => {
    const db = openSqliteDatabase(':memory:')
    const state = emptyAdmissionState(1_000)
    const withActivity: AdmissionState = {
      ...state,
      activeInteractive: 2,
      activeBackground: 1,
      laneActive: { ...state.laneActive, desktop: 3 },
      windowStarts: 7,
      laneWindowStarts: { ...state.laneWindowStarts, desktop: 7 },
      queued: 1
    }
    saveAdmissionState(db, withActivity)
    expect(loadAdmissionState(db, 2_000).activeInteractive).toBe(2)
    expect(loadAdmissionState(db, 2_000).windowStarts).toBe(7)

    resetActiveAdmissionOnStartup(db, 2_000)
    const after = loadAdmissionState(db, 2_000)
    expect(after.activeInteractive).toBe(0)
    expect(after.activeBackground).toBe(0)
    expect(after.laneActive.desktop).toBe(0)
    expect(after.queued).toBe(0)
    // 速率/配额计数保留(防重启绕过限流)
    expect(after.windowStarts).toBe(7)
  })

  it('损坏状态 JSON 收敛空状态(fail-closed);策略可配且非法值收敛默认', () => {
    const db = openSqliteDatabase(':memory:')
    saveAdmissionState(db, emptyAdmissionState(0))
    setConfigValue(db, 'admission.state', '{broken')
    expect(loadAdmissionState(db, 0).activeInteractive).toBe(0)

    // 策略:合法覆盖生效,非法收敛默认
    setConfigValue(db, 'admission.policy.globalMaxConcurrent', '3')
    setConfigValue(db, 'admission.policy.queueLimit', 'not-a-number')
    const policy = resolveAdmissionPolicy(db)
    expect(policy.globalMaxConcurrent).toBe(3)
    expect(policy.queueLimit).toBe(DEFAULT_ADMISSION_POLICY.queueLimit)
  })
})
