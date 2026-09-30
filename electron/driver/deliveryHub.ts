import { logAgentEvent } from '../agentLogger/agentLogger'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SqliteDeliveryJournal, PersistedDeliveryIntent } from './sqliteDeliveryJournal'

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
  deliveryId?: string
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
  | 'delivery-uncertain'

export class DeliveryUncertainError extends Error {
  constructor(message: string) { super(message); this.name = 'DeliveryUncertainError' }
}

export type DeliveryRecord = {
  seq: number
  ts: number
  kind: string
  driverId?: DeliveryDriverId
  supersedeKey?: string
  deliveryId?: string
  outcome: DeliveryOutcome
  error?: string
}

export type DeliveryHub = {
  registerDriver(driver: DeliveryDriver): void
  /** 驱动源可达性上报（状态由 driver.isReachable 提供；此方法供外部状态源刷新 + 触发 flush）。 */
  reportReachability(driverId: DeliveryDriverId): Promise<number>
  deliver(preference: DeliveryPreference, payload: DeliveryPayload): Promise<DeliveryRecord>
  deliverAll(preference: DeliveryPreference, payload: DeliveryPayload): Promise<readonly DeliveryRecord[]>
  /** 重投所有 deferred 记录（驱动源恢复可达后调用）；返回成功补投数。 */
  flushDeferred(): Promise<number>
  /** 送达台账（内存窗口；agentLogger 同时落 JSON Lines）。 */
  getRecords(): readonly DeliveryRecord[]
}

export function createDeliveryHub(options: { now?: () => number; recordLimit?: number; journal?: SqliteDeliveryJournal; onDeferredSettled?: () => void } = {}): DeliveryHub {
  const now = options.now ?? Date.now
  const recordLimit = options.recordLimit ?? 200
  const drivers = new Map<DeliveryDriverId, DeliveryDriver>()
  const records: DeliveryRecord[] = []
  // 快照入队时刻的 driver 引用：覆盖注册后旧积压不得发给新目标（错投）
  const deferred: Array<{ preference: DeliveryPreference; payload: DeliveryPayload; ts: number; driver: DeliveryDriver }> = []
  const DEFERRED_LIMIT = 200
  const supersedeState = new Map<string, { delivered: boolean; lastSeq: number; deliveryId?: string }>()
  const supersedeIndexKey = (driverId: string, key: string) => `${driverId}\u0000${key}`
  const setSupersedeIntent = (driverId: string, key: string | undefined, deliveryId: string | undefined, delivered: boolean, lastSeq: number) => {
    if (key) supersedeState.set(supersedeIndexKey(driverId, key), { delivered, lastSeq, deliveryId })
  }
  const setSupersedeOutcomeIfLatest = (driverId: string, key: string | undefined, deliveryId: string | undefined, delivered: boolean, lastSeq: number) => {
    if (!key) return
    const index = supersedeIndexKey(driverId, key)
    if (supersedeState.get(index)?.deliveryId === deliveryId) supersedeState.set(index, { delivered, lastSeq, deliveryId })
  }
  let seqCounter = 0
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  const journalIntent = (preference: DeliveryPreference, payload: DeliveryPayload, driverId: string, ts: number): PersistedDeliveryIntent => ({
    deliveryId: preference.deliveryId ?? '', target: driverId, preference, payload, status: 'pending', createdAt: ts
  })
  for (const pending of options.journal?.listResumable() ?? []) {
    const driver = drivers.get(pending.target)
    if (driver) deferred.push({ preference: pending.preference, payload: pending.payload, ts: pending.createdAt, driver })
    else deferred.push({ preference: pending.preference, payload: pending.payload, ts: pending.createdAt, driver: { id: pending.target, isReachable: () => false, deliver: async () => undefined } })
  }
  for (const latest of options.journal?.listLatestSupersedeStates?.() ?? []) {
    supersedeState.set(supersedeIndexKey(latest.target, latest.supersedeKey), {
      delivered: latest.status === 'delivered',
      lastSeq: 0,
      deliveryId: latest.deliveryId
    })
  }

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

  // Expire durable backlog during recovery even when the driver remains offline.
  // Otherwise an item that can never be sent within its TTL keeps its run pending forever.
  for (let index = deferred.length - 1; index >= 0; index -= 1) {
    const item = deferred[index]!
    if (!hasDrivenExpired(item.preference, item.ts)) continue
    try {
      options.journal?.transition(journalIntent(item.preference, item.payload, item.driver.id, item.ts), 'expired')
    } catch {
      // Keep the item resumable if its terminal status could not be persisted.
      continue
    }
    deferred.splice(index, 1)
    emitRecord({ kind: item.payload.kind, driverId: item.driver.id, supersedeKey: item.preference.supersedeKey, deliveryId: item.preference.deliveryId, outcome: 'expired' })
  }

  async function deliverToDriver(
    driver: DeliveryDriver,
    preference: DeliveryPreference,
    payload: DeliveryPayload,
    ts: number
  ): Promise<DeliveryRecord> {
      if (!driver.isReachable()) {
        enqueueDeferred({ preference, payload, ts, driver })
        options.journal?.transition(journalIntent(preference, payload, driver.id, ts), 'deferred')
        const record = emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'deferred' })
        setSupersedeIntent(driver.id, preference.supersedeKey, preference.deliveryId, false, record.seq)
        return record
    }
    try {
      const intent = journalIntent(preference, payload, driver.id, ts)
      if (options.journal?.claimNewForDispatch) {
        const claimed = options.journal.claimNewForDispatch(intent)
        if (claimed === 'conflict') {
          return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'failed', error: 'DELIVERY_ID_CONFLICT' })
        }
        if (!claimed) {
          const priorStatus = preference.deliveryId ? options.journal.status(preference.deliveryId, driver.id) : undefined
          if (priorStatus === 'delivered') {
            return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'already-delivered' })
          }
          if (priorStatus === 'expired') return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'expired' })
          if (priorStatus === 'superseded') return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'superseded' })
          if (priorStatus === 'failed') return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'failed', error: 'PRIOR_DELIVERY_FAILED' })
          return emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'delivery-uncertain', error: 'PRIOR_DISPATCH_OUTCOME_UNKNOWN' })
        }
      } else options.journal?.transition(intent, 'delivering')
      setSupersedeIntent(driver.id, preference.supersedeKey, preference.deliveryId, false, seqCounter)
      await driver.deliver(payload)
      try {
        options.journal?.transition(intent, 'delivered')
      } catch (error) {
        try { options.journal?.transition(intent, 'delivery-uncertain', error instanceof Error ? error.message : String(error)) }
        catch { /* remote dispatch already happened; the in-memory outcome must still prevent a retry */ }
        const record = emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'delivery-uncertain', error: 'LOCAL_DELIVERY_ACK_FAILED' })
        setSupersedeOutcomeIfLatest(driver.id, preference.supersedeKey, preference.deliveryId, false, record.seq)
        return record
      }
      const record = emitRecord({ kind: payload.kind, driverId: driver.id, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'delivered' })
      setSupersedeOutcomeIfLatest(driver.id, preference.supersedeKey, preference.deliveryId, true, record.seq)
      return record
    } catch (e) {
      const uncertain = e instanceof DeliveryUncertainError
      options.journal?.transition(journalIntent(preference, payload, driver.id, ts), uncertain ? 'delivery-uncertain' : 'failed', e instanceof Error ? e.message : String(e))
      const record = emitRecord({
        kind: payload.kind,
        driverId: driver.id,
        supersedeKey: preference.supersedeKey,
        deliveryId: preference.deliveryId,
        outcome: uncertain ? 'delivery-uncertain' : 'failed',
        error: e instanceof Error ? e.message : String(e)
      })
      setSupersedeOutcomeIfLatest(driver.id, preference.supersedeKey, preference.deliveryId, false, record.seq)
      return record
    }
  }

  function emitRecord(parts: Omit<DeliveryRecord, 'seq' | 'ts'>): DeliveryRecord {
    seqCounter += 1
    const record: DeliveryRecord = { seq: seqCounter, ts: now(), ...parts }
    emit(record)
    return record
  }

  function supersedeDeferred(driverId: string, key: string, replacementDeliveryId?: string): void {
    for (let i = deferred.length - 1; i >= 0; i--) {
      const old = deferred[i]!
      if (old.driver.id !== driverId || old.preference.supersedeKey !== key) continue
      deferred.splice(i, 1)
      if (old.preference.deliveryId === replacementDeliveryId) continue
      emitRecord({ kind: old.payload.kind, driverId: old.driver.id, supersedeKey: key, deliveryId: old.preference.deliveryId, outcome: 'superseded' })
      options.journal?.transition(journalIntent(old.preference, old.payload, old.driver.id, old.ts), 'superseded')
      options.onDeferredSettled?.()
    }
  }

  function enqueueDeferred(item: { preference: DeliveryPreference; payload: DeliveryPayload; ts: number; driver: DeliveryDriver }): void {
    if (item.preference.supersedeKey) supersedeDeferred(item.driver.id, item.preference.supersedeKey, item.preference.deliveryId)
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
      options.journal?.transition(journalIntent(dropped.preference, dropped.payload, dropped.driver.id, dropped.ts), 'failed', 'DEFERRED_OVERFLOW')
      options.onDeferredSettled?.()
    }
    scheduleExpiry()
  }

  function hasDrivenExpired(preference: DeliveryPreference, ts: number): boolean {
    const ttl = preference.ttlMs ?? DEFAULT_DELIVERY_TTL_MS
    return now() - ts > ttl
  }

  function expireDeferred(): number {
    let expiredCount = 0
    for (let index = deferred.length - 1; index >= 0; index -= 1) {
      const item = deferred[index]!
      if (!hasDrivenExpired(item.preference, item.ts)) continue
      try {
        options.journal?.transition(journalIntent(item.preference, item.payload, item.driver.id, item.ts), 'expired')
      } catch {
        continue
      }
      deferred.splice(index, 1)
      emitRecord({ kind: item.payload.kind, driverId: item.driver.id, supersedeKey: item.preference.supersedeKey, deliveryId: item.preference.deliveryId, outcome: 'expired' })
      expiredCount += 1
    }
    if (expiredCount > 0) options.onDeferredSettled?.()
    return expiredCount
  }

  function scheduleExpiry(retryDelayMs = 0): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = undefined
    if (deferred.length === 0) return
    const nextExpiryAt = Math.min(...deferred.map((item) => item.ts + (item.preference.ttlMs ?? DEFAULT_DELIVERY_TTL_MS) + 1))
    const untilExpiry = Math.max(0, nextExpiryAt - now())
    const delay = untilExpiry === 0 && retryDelayMs > 0 ? retryDelayMs : Math.min(untilExpiry, 2_147_483_647)
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined
      expireDeferred()
      const stillExpired = deferred.some((item) => hasDrivenExpired(item.preference, item.ts))
      scheduleExpiry(stillExpired ? 1_000 : 0)
    }, delay)
    expiryTimer.unref?.()
  }

  scheduleExpiry()

  async function flushDeferred(): Promise<number> {
    let deliveredCount = 0
    let expiredCount = 0
    const pending = deferred.splice(0)
    for (const item of pending) {
      if (hasDrivenExpired(item.preference, item.ts)) {
        emitRecord({ kind: item.payload.kind, driverId: item.driver.id, supersedeKey: item.preference.supersedeKey, deliveryId: item.preference.deliveryId, outcome: 'expired' })
        options.journal?.transition(journalIntent(item.preference, item.payload, item.driver.id, item.ts), 'expired')
        expiredCount += 1
        continue
      }
      if (item.preference.supersedeKey) {
        const state = supersedeState.get(supersedeIndexKey(item.driver.id, item.preference.supersedeKey))
        if (state && state.deliveryId !== item.preference.deliveryId) {
          emitRecord({ kind: item.payload.kind, driverId: item.driver.id, supersedeKey: item.preference.supersedeKey, deliveryId: item.preference.deliveryId, outcome: 'superseded' })
          options.journal?.transition(journalIntent(item.preference, item.payload, item.driver.id, item.ts), 'superseded')
          continue
        }
      }
      if (item.preference.supersedeKey) {
        const state = supersedeState.get(supersedeIndexKey(item.driver.id, item.preference.supersedeKey))
        if (state?.delivered) {
          const alreadySent = item.preference.deliveryId === state.deliveryId
          emitRecord({ kind: item.payload.kind, driverId: item.driver.id, supersedeKey: item.preference.supersedeKey, deliveryId: item.preference.deliveryId, outcome: alreadySent ? 'already-delivered' : 'superseded' })
          if (!alreadySent) options.journal?.transition(journalIntent(item.preference, item.payload, item.driver.id, item.ts), 'superseded')
          continue
        }
      }
      const driver = item.driver
      if (!driver.isReachable()) {
        deferred.push(item)
        continue
      }
      try {
        const intent = journalIntent(item.preference, item.payload, driver.id, item.ts)
        if (options.journal?.claimForDispatch) {
          if (!options.journal.claimForDispatch(intent)) continue
        } else options.journal?.transition(intent, 'delivering')
        await driver.deliver(item.payload)
        try {
          options.journal?.transition(intent, 'delivered')
        } catch (error) {
          try { options.journal?.transition(intent, 'delivery-uncertain', error instanceof Error ? error.message : String(error)) }
          catch { /* no retry after the external dispatch, even when the journal is unavailable */ }
          emitRecord({ kind: item.payload.kind, driverId: driver.id, supersedeKey: item.preference.supersedeKey, deliveryId: item.preference.deliveryId, outcome: 'delivery-uncertain', error: 'LOCAL_DELIVERY_ACK_FAILED' })
          continue
        }
        emitRecord({ kind: item.payload.kind, driverId: driver.id, supersedeKey: item.preference.supersedeKey, outcome: 'delivered' })
        deliveredCount += 1
        setSupersedeOutcomeIfLatest(item.driver.id, item.preference.supersedeKey, item.preference.deliveryId, true, seqCounter)
      } catch (error) {
        const uncertain = error instanceof DeliveryUncertainError
        options.journal?.transition(journalIntent(item.preference, item.payload, driver.id, item.ts), uncertain ? 'delivery-uncertain' : 'deferred', error instanceof Error ? error.message : String(error))
        if (!uncertain) deferred.push(item)
      }
    }
    if (expiredCount > 0) options.onDeferredSettled?.()
    scheduleExpiry()
    return deliveredCount
  }

  return {
    registerDriver(driver) {
      // 覆盖注册 = 同 id 驱动源的目标/实现已更换：旧积压绑定的是失效目标，继续补投即错投——
      // 全部落 superseded（DEFERRED_TARGET_REPLACED 留痕）并从积压移除，不静默丢弃也不错投
      const previous = drivers.get(driver.id)
      const stale = previous ? deferred.filter((item) => item.driver.id === driver.id) : []
      for (const item of stale) {
        emitRecord({
          kind: item.payload.kind,
          driverId: driver.id,
          supersedeKey: item.preference.supersedeKey,
          outcome: 'superseded',
          error: 'DEFERRED_TARGET_REPLACED'
        })
        options.journal?.transition(journalIntent(item.preference, item.payload, item.driver.id, item.ts), 'superseded', 'DEFERRED_TARGET_REPLACED')
      }
      if (stale.length > 0) options.onDeferredSettled?.()
      for (let i = deferred.length - 1; i >= 0; i--) {
        if (previous && deferred[i]!.driver.id === driver.id) deferred.splice(i, 1)
      }
      if (!previous) for (const item of deferred) if (item.driver.id === driver.id) item.driver = driver
      if (stale.length > 0) {
        logAgentEvent('info', 'driver.deferred.invalidated', { driverId: driver.id, count: stale.length })
      }
      scheduleExpiry()
      drivers.set(driver.id, driver)
    },
    async reportReachability(driverId) {
      const driver = drivers.get(driverId)
      if (driver?.isReachable()) return flushDeferred()
      return 0
    },
    async deliver(preference, payload) {
      const records = await this.deliverAll(preference, payload)
      return records.at(-1)!
    },
    async deliverAll(preference, payload) {
      const callerProvidedDeliveryId = preference.deliveryId !== undefined
      preference = { ...preference, deliveryId: preference.deliveryId ?? randomUUID() }
      const ts = now()

      // 目标解析：单目标默认 / 多目标必须显式
      const targets = preference.targets ?? (preference.target !== undefined ? [preference.target] : [])
      if (targets.length === 0) {
        return [emitRecord({ kind: payload.kind, outcome: 'failed', error: 'DELIVERY_NO_TARGET' })]
      }
      const outcomes: DeliveryRecord[] = []
      for (const target of targets) {
        const persistedIntent = preference.deliveryId ? options.journal?.intent?.(preference.deliveryId, target) : undefined
        if (persistedIntent && (!isDeepStrictEqual(persistedIntent.payload, payload)
          || persistedIntent.preference.supersedeKey !== preference.supersedeKey)) {
          outcomes.push(emitRecord({ kind: payload.kind, driverId: target, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'failed', error: 'DELIVERY_ID_CONFLICT' }))
          continue
        }
        if (preference.supersedeKey) {
          const state = supersedeState.get(supersedeIndexKey(target, preference.supersedeKey))
          if (state?.delivered && (!callerProvidedDeliveryId || state.deliveryId === preference.deliveryId)) {
            outcomes.push(emitRecord({ kind: payload.kind, driverId: target, supersedeKey: preference.supersedeKey, outcome: 'already-delivered' }))
            continue
          }
          if (state && state.deliveryId !== preference.deliveryId && !persistedIntent) {
            emitRecord({ kind: payload.kind, driverId: target, supersedeKey: preference.supersedeKey, deliveryId: state.deliveryId, outcome: 'superseded' })
          }
        }
        const priorStatus = preference.deliveryId ? options.journal?.status(preference.deliveryId, target) : undefined
        if (priorStatus === 'delivered') {
          outcomes.push(emitRecord({ kind: payload.kind, driverId: target, supersedeKey: preference.supersedeKey, outcome: 'already-delivered' }))
          continue
        }
        if (priorStatus === 'delivery-uncertain' || priorStatus === 'delivering') {
          outcomes.push(emitRecord({ kind: payload.kind, driverId: target, supersedeKey: preference.supersedeKey, outcome: 'delivery-uncertain', error: 'PRIOR_DISPATCH_OUTCOME_UNKNOWN' }))
          continue
        }
        if (persistedIntent && preference.supersedeKey) {
          const state = supersedeState.get(supersedeIndexKey(target, preference.supersedeKey))
          if (state && state.deliveryId !== preference.deliveryId) {
            outcomes.push(emitRecord({ kind: payload.kind, driverId: target, supersedeKey: preference.supersedeKey, deliveryId: preference.deliveryId, outcome: 'superseded' }))
            options.journal?.transition(persistedIntent, 'superseded')
            continue
          }
        }
        if (preference.supersedeKey) supersedeDeferred(target, preference.supersedeKey, preference.deliveryId)
        const driver = drivers.get(target)
        outcomes.push(driver
          ? await deliverToDriver(driver, preference, payload, ts)
          : emitRecord({ kind: payload.kind, driverId: target, supersedeKey: preference.supersedeKey, outcome: 'failed', error: `DELIVERY_UNKNOWN_DRIVER(${target})` }))
      }
      const last = outcomes.at(-1)
      if (preference.supersedeKey) {
        for (const outcome of outcomes) if (outcome.driverId && outcome.outcome === 'delivered') {
          setSupersedeOutcomeIfLatest(outcome.driverId, preference.supersedeKey, preference.deliveryId, true, outcome.seq)
        }
      }
      return outcomes
    },
    flushDeferred,
    getRecords: () => records
  }
}
