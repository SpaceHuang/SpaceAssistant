import { describe, expect, it } from 'vitest'
import { readHistoryToolExecutor } from './historyTool'

describe('history.read Core contract', () => {
  it('uses the session-scoped facts supplied by the tool-loop context', async () => {
    const result = await readHistoryToolExecutor({ entry_id: 'old-1' }, {
      sessionId: 'session-1',
      historyFacts: [{ id: 'old-1', sessionId: 'session-1', windowId: 'window-1', text: 'checkpoint detail', tokens: 2 }]
    } as any)
    expect(result).toEqual({ success: true, data: { entries: [{ id: 'old-1', sessionId: 'session-1', windowId: 'window-1', text: 'checkpoint detail', tokens: 2 }], nextCursor: null } })
  })
})
