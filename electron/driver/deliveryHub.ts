import { logAgentEvent } from '../agentLogger/agentLogger'

/**
 * 驱动源层统一投递入口（P6，偏差 8 机制面）。
 *
 * - `deliver(preference, payload)` 唯一入口；驱动源注册 + 可达性上报。
 * - 送达记录：每次投递必有记录（成对性），落 agentLogger 台账 + 内存窗口。
 * - 有界补投三件套由产生方声明：TTL / 取代键 / 送达即止；缺失按显式默认（有限 TTL）。
 * - 可达性缺失延后不丢弃（deferred），恢复后 flush 重投。
 * - 桌面终态发送通道（notifyMainWindow 路径）与文件树 / 文件内容直连点**不迁**（驱动权路径认领）。
 */

/** 缺省 TTL：有限（与「不得静默默认」同一条纪律——缺省值显式声明于此）。 */
export const DEFAULT_DELIVERY_TTL_MS = 10 * 60 * 1000

export type DeliveryDriverId = string

export type DeliveryPreference = {
  /** 单目标（默认）。 */
  target?: DeliveryDriverId
  /** 多目标必须显式声明（与单目标互斥）。 */
  targets?: DeliveryDriverId[]
  /** 有界补投：结果有效期；超期标「未送达且已过期」（不算失败）。 */
  ttlMs?: number
  /** 有界补投：取代键——新结果取代旧结果；送达即止。 */
  supersedeKey?: string
}

export type DeliveryPayload = {
  kind: string
  text?: string
  meta?: Record<string, unknown>
}

export type DeliveryDriver = {
  id: DeliveryDriverId
  isReachable(): boolean
  deliver(payload: DeliveryPayload): Promise<void>
}

export type DeliveryOutcome =
  | 'delivered'
  | 'failed'
  | 'expired'
  | 'superseded'
  | 'already-delivered'
  | 'deferred'

export type DeliveryRecord = {
  seq: number
  ts: number
  kind: string
  driverId?: DeliveryDriverId
  supersedeKey?: string
  outcome: DeliveryOutcome
  error?: string
}

export type DeliveryHub = {
  registerDriver(driver: DeliveryDriver): void
  /** 驱动源可达性上报（状态由 driver.isReachable 提供；此方法供外部状态源刷新 + 触发 flush）。 */
  reportReachability(driverId: DeliveryDriverId): Promise<number>
  deliver(preference: DeliveryPreference, payload: DeliveryPayload): Promise<DeliveryRecord>
  /** 重投所有 deferred 记录（驱动源恢复可达后调用）；返回成功补投数。 */
  flushDeferred(): Promise<number>
  /** 送达台账（内存窗口；agentLogger 同时落 JSON Lines）。 */
  getRecords(): readonly DeliveryRecord[]
}

export function createDeliveryHub(options: { now?: () => number; recordLimit?: number } = {}): DeliveryHub {
  const now = options.now ?? Date.now
  const recordLimit = options.recordLimit ?? 200
  const drivers = new Map<DeliveryDriverId, DeliveryDriver>()
  const records: DeliveryRecord[] = []
  // 快照入队时刻的 driver 引用：覆盖注册后旧积压不得发给新目标（错投）
  const deferred: Array<{ preference: DeliveryPreference; payload: DeliveryPayload; ts: number; driver: DeliveryDriver }> = []
  const DEFERRED_LIMIT = 200
  const supersedeState = new Map<string, { delivered: boolean; lastSeq: number }>()
  let seqCounter = 0

  function emit(record: DeliveryRecord): void {
    records.push(record)
    if (records.length > recordLimit) records.splice(0, records.length - recordLimit)
    logAgentEvent('info', 'driver.delivery.record', {
      seq: record.seq,
      kind: record.kind,
      driverId: record.driverId,
      outcome: record.outcome,
      ...(record.supersedeKey ? { supersedeKey: record.supersedeKey } : {}),
      ...(record.error ? { error: record.error } : {})
    })
  }

  async function deliverToDriver(
    driver: DeliveryDriver,
    preference: DeliveryPreference,
    payload: DeliveryPayload,
    ts: number
  ): Promise<DeliveryRecord> {
    if (!driver.isReachable()) {
      enqueueDeferred({ preference, payload, ts, driver })
      return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, outcome: 'deferred' })
    }
    try {
      await driver.deliver(payload)
      return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, outcome: 'delivered' })
    } catch (e) {
      return emitRecord({
        kind: payload.kind,
        driverId: driver.id,
        supersedeKey: preference.supersedeKey,
        outcome: 'failed',
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  function emitRecord(parts: Omit<DeliveryRecord, 'seq' | 'ts'>): DeliveryRecord {
    seqCounter += 1
    const record: DeliveryRecord = { seq: seqCounter, ts: now(), ...parts }
    emit(record)
    return record
  }

  function enqueueDeferred(item: { preference: DeliveryPreference; payload: DeliveryPayload; ts: number; driver: DeliveryDriver }): void {
    deferred.push(item)
    if (deferred.length > DEFERRED_LIMIT) {
      // 有界积压：溢出丢最旧并落 failed 记录（不静默丢弃）
      const dropped = deferred.shift()!
      emitRecord({
        kind: dropped.payload.kind,
        driverId: dropped.driver.id,
        supersedeKey: dropped.preference.supersedeKey,
        outcome: 'failed',
        error: 'DEFERRED_OVERFLOW'
      })
    }
  }

  function hasDrivenExpired(preference: DeliveryPreference, ts: number): boolean {
    const ttl = preference.ttlMs ?? DEFAULT_DELIVERY_TTL_MS
    return now() - ts > ttl
  }

  async function flushDeferred(): Promise<number> {
    let deliveredCount = 0
    const pending = deferred.splice(0)
    for (const item of pending) {
      if (hasDrivenExpired(item.preference, item.ts)) {
        emitRecord({ kind: item.payload.kind, driverId: item.preference.target, supersedeKey: item.preference.supersedeKey, outcome: 'expired' })
        continue
      }
      if (item.preference.supersedeKey) {
        const state = supersedeState.get(item.preference.supersedeKey)
        if (state?.delivered) {
          emitRecord({ kind: item.payload.kind, supersedeKey: item.preference.supersedeKey, outcome: 'already-delivered' })
          continue
        }
      }
      const driver = item.driver
      if (!driver.isReachable()) {
        deferred.push(item)
        continue
      }
      try {
        await driver.deliver(item.payload)
        emitRecord({ kind: item.payload.kind, driverId: driver.id, supersedeKey: item.preference.supersedeKey, outcome: 'delivered' })
        deliveredCount += 1
        if (item.preference.supersedeKey) {
          supersedeState.set(item.preference.supersedeKey, { delivered: true, lastSeq: seqCounter })
        }
      } catch {
        deferred.push(item)
      }
    }
    return deliveredCount
  }

  return {
    registerDriver(driver) {
      // 覆盖注册 = 同 id 驱动源的目标/实现已更换：旧积压绑定的是失效目标，继续补投即错投——
      // 全部落 superseded（DEFERRED_TARGET_REPLACED 留痕）并从积压移除，不静默丢弃也不错投
      const stale = deferred.filter((item) => item.driver.id === driver.id)
      for (const item of stale) {
        emitRecord({
          kind: item.payload.kind,
          driverId: driver.id,
          supersedeKey: item.preference.supersedeKey,
          outcome: 'superseded',
          error: 'DEFERRED_TARGET_REPLACED'
        })
      }
      for (let i = deferred.length - 1; i >= 0; i--) {
        if (deferred[i]!.driver.id === driver.id) deferred.splice(i, 1)
      }
      if (stale.length > 0) {
        logAgentEvent('info', 'driver.deferred.invalidated', { driverId: driver.id, count: stale.length })
      }
      drivers.set(driver.id, driver)
    },
    async reportReachability(driverId) {
      const driver = drivers.get(driverId)
      if (driver?.isReachable()) return flushDeferred()
      return 0
    },
    async deliver(preference, payload) {
      const ts = now()

      // 取代键语义：送达即止 + 新结果取代旧结果
      if (preference.supersedeKey) {
        const state = supersedeState.get(preference.supersedeKey)
        if (state?.delivered) {
          return emitRecord({ kind: payload.kind, supersedeKey: preference.supersedeKey, outcome: 'already-delivered' })
        }
        if (state) {
          // 新结果取代旧结果：旧记录标 superseded（被取代痕迹在台账可查）
          const oldRecord = records.find((r) => r.seq === state.lastSeq)
          if (oldRecord && (oldRecord.outcome === 'failed' || oldRecord.outcome === 'deferred')) {
            oldRecord.outcome = 'superseded'
          } else {
            emitRecord({ kind: payload.kind, supersedeKey: preference.supersedeKey, outcome: 'superseded' })
          }
        }
      }

      // 目标解析：单目标默认 / 多目标必须显式
      const targets = preference.targets ?? (preference.target !== undefined ? [preference.target] : [])
      if (targets.length === 0) {
        return emitRecord({ kind: payload.kind, outcome: 'failed', error: 'DELIVERY_NO_TARGET' })
      }
      for (const target of targets) {
        if (!drivers.has(target)) {
          return emitRecord({ kind: payload.kind, driverId: target, outcome: 'failed', error: `DELIVERY_UNKNOWN_DRIVER(${target})` })
        }
      }

      let last: DeliveryRecord | undefined
      for (const target of targets) {
        const driver = drivers.get(target)!
        last = await deliverToDriver(driver, preference, payload, ts)
      }
      if (preference.supersedeKey && last?.outcome === 'delivered') {
        // 新结果送达：同键旧的非送达记录标 superseded（被取代痕迹在台账可查）
        for (const r of records) {
          if (r.supersedeKey === preference.supersedeKey && (r.outcome === 'failed' || r.outcome === 'deferred')) {
            r.outcome = 'superseded'
          }
        }
        supersedeState.set(preference.supersedeKey, { delivered: true, lastSeq: last.seq })
      }
      return last!
    },
    flushDeferred,
    getRecords: () => records
  }
}
