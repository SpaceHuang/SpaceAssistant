import { describe, expect, it, vi } from 'vitest'
import { TurnDisplayReconciliation } from './turnDisplayReconciliation'

const display = { turnId: 't1', sessionId: 's1', requestId: 'r1', version: 2, lifecycle: 'completed' as const, message: { id: 'm1', content: 'done', contentSegments: [], toolCalls: [], activity: [] } }

describe('TurnDisplayReconciliation', () => {
  it('active known 查询 single-flight 并把 changed 写入 store', async () => {
    const read = vi.fn().mockResolvedValue({ changed: [display] })
    const service = new TurnDisplayReconciliation(read)
    service.remember({ turnId: 't1', version: 1 })
    await Promise.all([service.reconcile(), service.reconcile()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(service.getKnown()).toEqual([])
  })

  it('读取失败不丢失 active known，下一次可重试', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ changed: [] })
    const service = new TurnDisplayReconciliation(read)
    service.remember({ turnId: 't1', version: 1 })
    await expect(service.reconcile()).rejects.toThrow('offline')
    expect(service.getKnown()).toEqual([{ turnId: 't1', version: 1 }])
    await service.reconcile()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('清理时同时丢弃 known，避免重新挂载复用旧版本', () => {
    const service = new TurnDisplayReconciliation(vi.fn())
    service.remember({ turnId: 't1', version: 3 })
    service.clear()
    expect(service.getKnown()).toEqual([])
  })
})
