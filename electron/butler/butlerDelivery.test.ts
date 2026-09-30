import { describe, expect, it, vi } from 'vitest'
import { deliverTaskResult, registerButlerDeliveryDrivers, shouldDeliverRun } from './butlerDelivery'
import { createDeliveryHub } from '../driver/deliveryHub'
import { SqliteDeliveryJournal } from '../driver/sqliteDeliveryJournal'
import { createMemoryAppDb } from '../database/testHelpers'

function base(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      id: 'task-1',
      name: '每日巡检',
      deliveryPref: 'desktop' as const,
      deliveryTarget: 'test-target',
      ...overrides.task
    },
    run: {
      runId: 'run-1',
      status: 'completed' as const,
      resultSummary: '磁盘 42% 已用',
      ...overrides.run
    },
    ports: overrides.ports ?? {},
    ...(overrides.hub ? { hub: overrides.hub } : {})
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

  it('feishu：发送结果未知时不自动降级，避免双渠道重复通知', async () => {
    const sendFeishu = vi.fn(async () => {
      throw new Error('bot offline')
    })
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'feishu' }, ports: { sendFeishu, notifyDesktop } }) as never
    )
    expect(result.status).toBe('delivery-uncertain')
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('feishu：平台端口未接线时结果进入 pending', async () => {
    const result = await deliverTaskResult(base({ task: { deliveryPref: 'feishu' } }) as never)
    expect(result.status).toBe('pending')
  })

  it('SQLite 重启后 reachability flush 恢复 Butler deferred IM delivery', async () => {
    const db = createMemoryAppDb()
    const firstHub = createDeliveryHub({ journal: new SqliteDeliveryJournal(db) })
    const disconnected = deliverTaskResult(base({
      task: { deliveryPref: 'feishu' },
      ports: { sendFeishu: vi.fn(async () => undefined), isFeishuReachable: () => false }, hub: firstHub
    }) as never)
    await expect(disconnected).resolves.toMatchObject({ status: 'pending' })

    const sendFeishu = vi.fn(async () => undefined)
    const restoredHub = createDeliveryHub({ journal: new SqliteDeliveryJournal(db) })
    registerButlerDeliveryDrivers(restoredHub, { sendFeishu, isFeishuReachable: () => true })
    await expect(restoredHub.reportReachability('feishu')).resolves.toBe(1)
    expect(sendFeishu).toHaveBeenCalledOnce()
    expect(new SqliteDeliveryJournal(db).status('run-1', 'feishu')).toBe('delivered')
    db.close()
  })

  it('IM external send succeeded but local ack failed: after hub restart, uncertain is not resent or degraded', async () => {
    const db = createMemoryAppDb()
    const conn = (await import('../database/sqliteStore')).getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_butler_delivery_ack BEFORE UPDATE OF status ON driver_deliveries
      WHEN NEW.status='delivered' BEGIN SELECT RAISE(ABORT, 'injected local ack failure'); END`)
    const firstSend = vi.fn(async () => undefined)
    const firstHub = createDeliveryHub({ journal: new SqliteDeliveryJournal(db) })
    const result = await deliverTaskResult(base({ task: { deliveryPref: 'feishu' }, ports: { sendFeishu: firstSend }, hub: firstHub }) as never)
    expect(result.status).toBe('delivery-uncertain')
    expect(firstSend).toHaveBeenCalledOnce()

    const retrySend = vi.fn(async () => undefined)
    const notifyDesktop = vi.fn()
    const restartedHub = createDeliveryHub({ journal: new SqliteDeliveryJournal(db) })
    const retry = await deliverTaskResult(base({ task: { deliveryPref: 'feishu' }, ports: { sendFeishu: retrySend, notifyDesktop }, hub: restartedHub }) as never)
    expect(retry.status).toBe('delivery-uncertain')
    expect(retrySend).not.toHaveBeenCalled()
    expect(notifyDesktop).not.toHaveBeenCalled()
    db.close()
  })

  it('Feishu target 缺失时不创建 IM pending 项，并用桌面说明失败原因', async () => {
    const notifyDesktop = vi.fn()
    const hub = (await import('../driver/deliveryHub')).createDeliveryHub()
    const result = await deliverTaskResult(base({ task: { deliveryPref: 'feishu', deliveryTarget: undefined }, ports: { notifyDesktop }, hub }) as never)
    expect(result.status).toBe('failed-degraded')
    expect(notifyDesktop).toHaveBeenCalledOnce()
    expect(hub.getRecords()).toHaveLength(1)
    expect(hub.getRecords()[0]).toMatchObject({ driverId: 'desktop', outcome: 'delivered' })
  })

  it('wechat：发送结果未知时不自动降级', async () => {
    const sendWechat = vi.fn(async () => {
      throw new Error('bot offline')
    })
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'wechat' }, ports: { sendWechat, notifyDesktop } }) as never
    )
    expect(result.status).toBe('delivery-uncertain')
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('wechat：端口未接线时保留 pending，避免向另一个目标重复投递', async () => {
    const notifyDesktop = vi.fn()
    const result = await deliverTaskResult(
      base({ task: { deliveryPref: 'wechat' }, ports: { notifyDesktop } }) as never
    )
    expect(result.status).toBe('pending')
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('共享 hub 不重注册任务闭包，连续 run 各自使用自己的目标元数据', async () => {
    const { createDeliveryHub } = await import('../driver/deliveryHub')
    const hub = createDeliveryHub()
    const sends: string[] = []
    const ports = { sendFeishu: vi.fn(async (text: string, target?: string) => { sends.push(`${target}:${text}`) }) }
    for (const [runId, target] of [['r1', 'chat-a'], ['r2', 'chat-b']] as const) {
      await deliverTaskResult({
        task: { id: 'same-task', name: 'task', deliveryPref: 'feishu', deliveryTarget: target },
        run: { runId, status: 'completed', resultSummary: runId }, ports, hub
      })
    }
    expect(sends).toHaveLength(2)
    expect(sends[0]).toContain('chat-a:')
    expect(sends[1]).toContain('chat-b:')
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
