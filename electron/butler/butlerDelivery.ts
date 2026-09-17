import { buildSimpleOutboundText } from '../remote/imRemoteOutbound'
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
}

export type ButlerDeliveryResult = {
  status: 'delivered' | 'failed-degraded' | 'none'
  /** 降级发生时记录原因，写回 run 的 error 字段留痕。 */
  degradedReason?: string
}

/** 只有 completed 的 run 才投递：skipped / failed / interrupted 不产生通知（有界性由调度侧保证）。 */
export function shouldDeliverRun(run: { status: string }): boolean {
  return run.status === 'completed'
}

const IM_MAX_LEN = 2000
const IM_TRUNCATION_SUFFIX = '…（内容过长已截断）'

async function deliverToIm(
  send: ((text: string, target?: string) => Promise<void>) | undefined,
  platform: string,
  input: ButlerDeliveryInput
): Promise<{ status: 'delivered' | 'failed-degraded'; degradedReason?: string }> {
  if (!send) {
    return { status: 'failed-degraded', degradedReason: `${platform} 投递端口未接线` }
  }
  try {
    const text = buildSimpleOutboundText({
      body: `[管家] ${input.task.name}\n${input.run.resultSummary ?? '任务已完成'}`,
      sessionId: input.run.sessionId,
      maxLen: IM_MAX_LEN,
      truncationSuffix: IM_TRUNCATION_SUFFIX
    })
    await send(text, input.task.deliveryTarget)
    return { status: 'delivered' }
  } catch (error) {
    return {
      status: 'failed-degraded',
      degradedReason: `${platform} 投递失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export async function deliverTaskResult(input: ButlerDeliveryInput): Promise<ButlerDeliveryResult> {
  const { task, run, ports } = input

  if (task.deliveryPref === 'none') {
    return { status: 'none' }
  }

  if (task.deliveryPref === 'feishu') {
    const imResult = await deliverToIm(ports.sendFeishu, 'feishu', input)
    if (imResult.status === 'delivered') return { status: 'delivered' }
    if (ports.notifyDesktop) {
      ports.notifyDesktop(run.resultSummary ?? '任务已完成', { taskId: task.id, taskName: task.name, ...(run.sessionId ? { sessionId: run.sessionId } : {}), runId: run.runId })
      return { status: 'failed-degraded', degradedReason: imResult.degradedReason }
    }
    return imResult
  }

  if (task.deliveryPref === 'wechat') {
    const imResult = await deliverToIm(ports.sendWechat, 'wechat', input)
    if (imResult.status === 'delivered') return { status: 'delivered' }
    if (ports.notifyDesktop) {
      ports.notifyDesktop(run.resultSummary ?? '任务已完成', { taskId: task.id, taskName: task.name, ...(run.sessionId ? { sessionId: run.sessionId } : {}), runId: run.runId })
      return { status: 'failed-degraded', degradedReason: imResult.degradedReason }
    }
    return imResult
  }

  // desktop
  if (ports.notifyDesktop) {
    ports.notifyDesktop(run.resultSummary ?? '任务已完成', { taskId: task.id, taskName: task.name, ...(run.sessionId ? { sessionId: run.sessionId } : {}), runId: run.runId })
    return { status: 'delivered' }
  }
  return { status: 'failed-degraded', degradedReason: '桌面通知端口未接线' }
}
