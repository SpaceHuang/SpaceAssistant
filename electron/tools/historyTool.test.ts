import { describe, expect, it } from 'vitest'
import { estimateTokensFromUtf8Text } from '../../src/shared/contextUsageEstimate'
import { readHistoryToolExecutor } from './historyTool'

const context = (historyFacts?: any[]) => ({ sessionId: 's1', historyFacts, signal: new AbortController().signal } as any)

describe('history.read tool', () => {
  it('reads only facts belonging to the authorized session and supports pagination', async () => {
    const result = await readHistoryToolExecutor({ window_id: 'w1', limit: 1 }, context([
      { id: 'a', sessionId: 's1', windowId: 'w1', text: 'old', tokens: 1 },
      { id: 'b', sessionId: 's1', windowId: 'w1', text: 'next', tokens: 1 },
      { id: 'secret', sessionId: 's2', windowId: 'w1', text: 'secret', tokens: 1 }
    ]))
    expect(result).toEqual({ success: true, data: { entries: [{ id: 'a', sessionId: 's1', windowId: 'w1', text: 'old', tokens: 1 }], nextCursor: '1' } })
  })

  it('rejects access when no authorized history snapshot is available', async () => {
    await expect(readHistoryToolExecutor({}, context())).resolves.toMatchObject({ success: false })
  })

  it('bounds full details while preserving正文 when an attachment contains huge base64', async () => {
    const result = await readHistoryToolExecutor({ entry_id: 'photo-1' }, context([{
      id: 'photo-1', sessionId: 's1', windowId: 'w1', text: '照片正文仍可读取', tokens: 8,
      details: { attachments: [{ fileName: 'photo.png', mimeType: 'image/png', byteLength: 7_000_000, data: 'a'.repeat(7_000_000) }] }
    }]))
    expect(result.success).toBe(true)
    const data = result.data as { entries: Array<{ text: string; details?: { attachments?: Array<Record<string, unknown>> } }> }
    expect(data.entries[0]?.text).toBe('照片正文仍可读取')
    expect(data.entries[0]?.details?.attachments?.[0]).toMatchObject({ fileName: 'photo.png', mimeType: 'image/png', byteLength: 7_000_000 })
    expect(data.entries[0]?.details?.attachments?.[0]?.data).toBe('[binary data omitted; originalLength=7000000]')
    expect(estimateTokensFromUtf8Text(JSON.stringify(result.data))).toBeLessThanOrEqual(4_000)
    expect(JSON.stringify(result.data)).not.toContain('a'.repeat(1_000))
  })
})
