import { describe, expect, it, vi } from 'vitest'
import { ToolCallDetailsLoader } from './toolCallDetailsLoader'

const key = { sessionId: 's1', turnId: 't1', messageId: 'm1', toolCallId: 'tool-1' }
const detail = { id: 'tool-1', toolName: 'grep', input: {}, status: 'completed' as const, riskLevel: 'low' as const }

describe('ToolCallDetailsLoader', () => {
  it('同一工具展开请求 single-flight，并缓存成功结果', async () => {
    let resolve!: (value: typeof detail) => void
    const read = vi.fn(() => new Promise<typeof detail>((r) => { resolve = r }))
    const loader = new ToolCallDetailsLoader(read)
    const first = loader.load(key)
    const second = loader.load(key)
    expect(first).toBe(second)
    resolve(detail)
    expect(await first).toEqual(detail)
    expect(await loader.load(key)).toEqual(detail)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('失败不写入缓存，下一次展开可重试', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(detail)
    const loader = new ToolCallDetailsLoader(read)
    await expect(loader.load(key)).rejects.toThrow('offline')
    expect(await loader.load(key)).toEqual(detail)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
