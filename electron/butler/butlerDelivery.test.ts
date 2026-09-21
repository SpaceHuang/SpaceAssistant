import { describe, expect, it, vi } from 'vitest'
import { deliverTaskResult, shouldDeliverRun } from './butlerDelivery'

function base(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: 'task-1',
      name: '每日巡检',
      deliveryPref: 'desktop' as const,
      ...overrides.task
    },
    run: {
      runId: 'run-1',
      status: 'completed' as const,
      resultSummary: '磁盘 42% 已用',
      ...overrides.run
    },
    ports: overrides.ports ?? {}
  }
}

describe('deliverTaskResult 投递薄分发（P5，偏差 8 不在此关闭）', () => {
  it('desktop：经桌面通知端口送达 → delivered', async () => {
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(base({ ports: { notifyDesktop } }) as never)
    expect(result.status).toBe('delivered')
    expect(notifyDesktop).toHaveBeenCalledTimes(1)
    expect(notifyDesktop.mock.calls[0]![0]).toContain('磁盘 42% 已用')
  })

  it('desktop：端口缺失 → failed-degraded（显式降级，不静默丢弃）', async () => {
    const result = await deliverTaskResult(base({}) as never)
    expect(result.status).toBe('failed-degraded')
  })

  it('feishu：发送成功 → delivered', async () => {
    const sendFeishu = vi.fn(async () => undefined)
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'feishu' }, ports: { sendFeishu } }) as never
    )
    expect(result.status).toBe('delivered')
    expect(sendFeishu).toHaveBeenCalledTimes(1)
  })

  it('feishu：发送失败 → 降级到桌面通知并记 failed-degraded', async () => {
    const sendFeishu = vi.fn(async () => {
      throw new Error('bot offline')
    })
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'feishu' }, ports: { sendFeishu, notifyDesktop } }) as never
    )
    expect(result.status).toBe('failed-degraded')
    expect(notifyDesktop).toHaveBeenCalledTimes(1)
  })

  it('feishu：平台端口未接线 + 桌面端口缺失 → failed-degraded', async () => {
    const result = await deliverTaskResult(base({ task: { deliveryPref: 'feishu' } }) as never)
    expect(result.status).toBe('failed-degraded')
  })

  it('wechat：发送失败 → 降级到桌面通知', async () => {
    const sendWechat = vi.fn(async () => {
      throw new Error('bot offline')
    })
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'wechat' }, ports: { sendWechat, notifyDesktop } }) as never
    )
    expect(result.status).toBe('failed-degraded')
    expect(notifyDesktop).toHaveBeenCalledTimes(1)
  })

  it('wechat：端口未接线 + 桌面可用 → 降级桌面通知且记录', async () => {
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'wechat' }, ports: { notifyDesktop } }) as never
    )
    expect(result.status).toBe('failed-degraded')
    expect(notifyDesktop).toHaveBeenCalledTimes(1)
  })

  it('none：仅落盘，不触发任何通知端口 → none', async () => {
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'none' }, ports: { notifyDesktop } }) as never
    )
    expect(result.status).toBe('none')
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('skipped run 不产生通知（谓词守卫）', async () => {
    expect(shouldDeliverRun({ status: 'completed' } as never)).toBe(true)
    expect(shouldDeliverRun({ status: 'skipped' } as never)).toBe(false)
    expect(shouldDeliverRun({ status: 'failed' } as never)).toBe(false)
    expect(shouldDeliverRun({ status: 'interrupted' } as never)).toBe(false)
  })
})
