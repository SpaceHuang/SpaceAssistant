import { buildSimpleOutboundText } from '../remote/imRemoteOutbound'
import { createDeliveryHub, DeliveryUncertainError, type DeliveryHub } from '../driver/deliveryHub'
import type { AutomationDeliveryPref } from './taskStore'

/**
 * 管家投递薄分发（P5，偏差 8 的显式单例外）：run 终态按任务配置送达三个目标之一。
 * 只做管家 v1 自己需要的最小投递；不动任何既有投递点、不建通用投递机制——
 * 未来块 1 / 复用面做偏差 8 整项时，本函数是第一个迁移进统一入口的调用方。
 *
 * 有界性：通知文本只取最新 run 的 result_summary；错过窗口的 run 在调度侧标 skipped，
 * 不进入本函数（见 shouldDeliverRun 守卫）。
 */

export type ButlerDeliveryPorts = {
  /** 桌面通知端口（主进程装配注入；v1 用系统通知，浮动窗结果展示随偏差 8 统一）。 */
  notifyDesktop?: (summary: string, meta: { taskId: string; taskName: string; sessionId?: string; runId: string }) => void
  /** 飞书出站端口（未接线 → 显式降级桌面）。 */
  sendFeishu?: (text: string, target?: string) => Promise<void>
  isFeishuReachable?: () => boolean
  /** 微信出站端口（未接线 → 显式降级桌面）。 */
  sendWechat?: (text: string, target?: string) => Promise<void>
  isWechatReachable?: () => boolean
}

export type ButlerDeliveryInput = {
  task: {
    id: string
    name: string
    deliveryPref: AutomationDeliveryPref
    deliveryTarget?: string
  }
  run: {
    runId: string
    status: string
    sessionId?: string
    resultSummary?: string
  }
  ports: ButlerDeliveryPorts
  /** P6：共享投递入口（装配器持有）；缺省为本次调用级 hub 实例（状态随调用走，不进模块级）。 */
  hub?: DeliveryHub
}

export type ButlerDeliveryResult = {
  status: 'delivered' | 'pending' | 'delivery-uncertain' | 'failed-degraded' | 'none'
  /** 降级发生时记录原因，写回 run 的 error 字段留痕。 */
  degradedReason?: string
  /** P6：统一入口的送达记录（偏差 8：哪条结果、投给哪个驱动源、何时、结果如何）。 */
  deliveryRecords?: Array<{ driverId: string; outcome: string }>
}

/** 只有 completed 的 run 才投递：skipped / failed / interrupted 不产生通知（有界性由调度侧保证）。 */
export function shouldDeliverRun(run: { status: string }): boolean {
  return run.status === 'completed'
}

const IM_MAX_LEN = 2000
const IM_TRUNCATION_SUFFIX = '…（内容过长已截断）'
const registeredHubs = new WeakSet<DeliveryHub>()

/** Register stable app-lifetime driver adapters during main-process assembly. */
export function registerButlerDeliveryDrivers(hub: DeliveryHub, ports: ButlerDeliveryPorts): void {
  if (registeredHubs.has(hub)) return
  hub.registerDriver({
    id: 'desktop',
    isReachable: () => Boolean(ports.notifyDesktop),
    deliver: async (payload) => {
      const meta = payload.meta ?? {}
      ports.notifyDesktop!(payload.text ?? '任务已完成', {
        taskId: String(meta.taskId ?? ''), taskName: String(meta.taskName ?? ''),
        ...(typeof meta.sessionId === 'string' ? { sessionId: meta.sessionId } : {}), runId: String(meta.runId ?? '')
      })
    }
  })
  const imDriver = (id: 'feishu' | 'wechat', send: ((text: string, target?: string) => Promise<void>) | undefined, isReachable: (() => boolean) | undefined) => ({
    id,
    isReachable: () => Boolean(send && (isReachable?.() ?? true)),
    deliver: async (payload: { text?: string; meta?: Record<string, unknown> }) => {
      try {
        await send!(buildSimpleOutboundText({ body: payload.text ?? '', sessionId: typeof payload.meta?.sessionId === 'string' ? payload.meta.sessionId : undefined, maxLen: IM_MAX_LEN, truncationSuffix: IM_TRUNCATION_SUFFIX }), typeof payload.meta?.deliveryTarget === 'string' ? payload.meta.deliveryTarget : undefined)
      } catch (error) { throw new DeliveryUncertainError(error instanceof Error ? error.message : String(error)) }
    }
  })
  hub.registerDriver(imDriver('feishu', ports.sendFeishu, ports.isFeishuReachable))
  hub.registerDriver(imDriver('wechat', ports.sendWechat, ports.isWechatReachable))
  registeredHubs.add(hub)
}

/** P6（偏差 8 首批迁移）：butler 投递经统一入口——端口包装为驱动源注册进 hub，送达记录成对落台账。 */
export async function deliverTaskResult(input: ButlerDeliveryInput): Promise<ButlerDeliveryResult> {
  const { task, run, ports } = input

  if (task.deliveryPref === 'none') {
    return { status: 'none' }
  }

  const hub = input.hub ?? createDeliveryHub()
  registerButlerDeliveryDrivers(hub, ports)

  const resultPayload = (text: string) => ({ kind: 'butler-run-result', text, meta: { taskId: task.id, taskName: task.name, runId: run.runId, ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(task.deliveryTarget ? { deliveryTarget: task.deliveryTarget } : {}) } })

  const missingTarget = async (target: 'feishu' | 'wechat'): Promise<ButlerDeliveryResult> => {
    const desktop = await hub.deliver({ target: 'desktop', ttlMs: 30_000 }, resultPayload(`${target === 'feishu' ? '飞书' : '微信'}投递未配置接收对象，结果未发送到 IM。`))
    return { status: 'failed-degraded', degradedReason: `${target} 投递未配置接收对象`, deliveryRecords: [{ driverId: 'desktop', outcome: desktop.outcome }] }
  }

  const withImFallback = async (target: 'feishu' | 'wechat'): Promise<ButlerDeliveryResult> => {
    if (!task.deliveryTarget?.trim()) return missingTarget(target)
    const imRecord = await hub.deliver({ deliveryId: run.runId, target, ttlMs: 30_000, supersedeKey: `butler:${task.id}:${target}` }, resultPayload(`[管家] ${task.name}\n${run.resultSummary ?? '任务已完成'}`))
    if (imRecord.outcome === 'delivered') {
      return { status: 'delivered', deliveryRecords: [{ driverId: target, outcome: imRecord.outcome }] }
    }
    if (imRecord.outcome === 'deferred') {
      return { status: 'pending', deliveryRecords: [{ driverId: target, outcome: imRecord.outcome }] }
    }
    if (imRecord.outcome === 'delivery-uncertain') {
      return { status: 'delivery-uncertain', degradedReason: `${target} 送达结果未知`, deliveryRecords: [{ driverId: target, outcome: imRecord.outcome }] }
    }
    // 发送异常结果可能无法证明远端未接收；保留本地失败，不自动发第二渠道。
    const desktopRecord = await hub.deliver({ target: 'desktop', ttlMs: 30_000 }, resultPayload(`原渠道投递未确认：${target}（${imRecord.outcome}）`))
    return {
      status: 'failed-degraded',
      degradedReason: `${target} 投递未完成（${imRecord.outcome}${imRecord.error ? `: ${imRecord.error}` : ''}）`,
      deliveryRecords: [
        { driverId: target, outcome: imRecord.outcome },
        { driverId: 'desktop', outcome: desktopRecord.outcome }
      ]
    }
  }

  if (task.deliveryPref === 'feishu') return withImFallback('feishu')
  if (task.deliveryPref === 'wechat') return withImFallback('wechat')

  // desktop
  const desktopRecord = await hub.deliver({ deliveryId: run.runId, target: 'desktop', ttlMs: 30_000, supersedeKey: `butler:${task.id}:desktop` }, resultPayload(run.resultSummary ?? '任务已完成'))
  if (desktopRecord.outcome === 'delivered') {
    return { status: 'delivered', deliveryRecords: [{ driverId: 'desktop', outcome: desktopRecord.outcome }] }
  }
  return {
    status: 'failed-degraded',
    degradedReason: '桌面通知端口未接线',
    deliveryRecords: [{ driverId: 'desktop', outcome: desktopRecord.outcome }]
  }
}
