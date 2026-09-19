import { buildSimpleOutboundText } from '../remote/imRemoteOutbound'
import { createDeliveryHub, type DeliveryHub } from '../driver/deliveryHub'
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
  /** 微信出站端口（未接线 → 显式降级桌面）。 */
  sendWechat?: (text: string, target?: string) => Promise<void>
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
  status: 'delivered' | 'failed-degraded' | 'none'
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

/** P6（偏差 8 首批迁移）：butler 投递经统一入口——端口包装为驱动源注册进 hub，送达记录成对落台账。 */
export async function deliverTaskResult(input: ButlerDeliveryInput): Promise<ButlerDeliveryResult> {
  const { task, run, ports } = input

  if (task.deliveryPref === 'none') {
    return { status: 'none' }
  }

  const hub = input.hub ?? createDeliveryHub()
  hub.registerDriver({
    id: 'desktop',
    isReachable: () => Boolean(ports.notifyDesktop),
    deliver: async (payload) => {
      ports.notifyDesktop!(payload.text ?? '任务已完成', {
        taskId: task.id,
        taskName: task.name,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        runId: run.runId
      })
    }
  })
  const imDriver = (id: 'feishu' | 'wechat', send: ((text: string, target?: string) => Promise<void>) | undefined) => ({
    id,
    isReachable: () => Boolean(send),
    deliver: async (payload: { text?: string }) => {
      await send!(buildSimpleOutboundText({
        body: payload.text ?? '',
        sessionId: run.sessionId,
        maxLen: IM_MAX_LEN,
        truncationSuffix: IM_TRUNCATION_SUFFIX
      }), task.deliveryTarget)
    }
  })
  hub.registerDriver(imDriver('feishu', ports.sendFeishu))
  hub.registerDriver(imDriver('wechat', ports.sendWechat))

  const withImFallback = async (target: 'feishu' | 'wechat'): Promise<ButlerDeliveryResult> => {
    const imRecord = await hub.deliver({ target, ttlMs: 30_000 }, { kind: 'butler-run-result', text: `[管家] ${task.name}\n${run.resultSummary ?? '任务已完成'}` })
    if (imRecord.outcome === 'delivered') {
      return { status: 'delivered', deliveryRecords: [{ driverId: target, outcome: imRecord.outcome }] }
    }
    // 显式降级桌面（保留 P5 降级语义；降级本身也经 hub 留送达记录）
    const desktopRecord = await hub.deliver({ target: 'desktop', ttlMs: 30_000 }, { kind: 'butler-run-result', text: run.resultSummary ?? '任务已完成' })
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
  const desktopRecord = await hub.deliver({ target: 'desktop', ttlMs: 30_000 }, { kind: 'butler-run-result', text: run.resultSummary ?? '任务已完成' })
  if (desktopRecord.outcome === 'delivered') {
    return { status: 'delivered', deliveryRecords: [{ driverId: 'desktop', outcome: desktopRecord.outcome }] }
  }
  return {
    status: 'failed-degraded',
    degradedReason: '桌面通知端口未接线',
    deliveryRecords: [{ driverId: 'desktop', outcome: desktopRecord.outcome }]
  }
}
