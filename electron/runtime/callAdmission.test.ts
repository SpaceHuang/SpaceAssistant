import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { openSqliteDatabase } from '../database/sqliteStore'
import { setConfigValue } from '../database/operations'
import {
  DEFAULT_ADMISSION_POLICY,
  applyAdmit,
  applyRelease,
  emptyAdmissionState,
  judgeAdmission,
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
