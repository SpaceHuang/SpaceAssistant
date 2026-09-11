import { describe, expect, it } from 'vitest'
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
})
