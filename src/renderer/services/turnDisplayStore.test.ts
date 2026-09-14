import { describe, expect, it } from 'vitest'
import { TurnDisplayStore } from './turnDisplayStore'

const display = (version: number, lifecycle: 'running' | 'completed' = 'running') => ({
  turnId: 't1', sessionId: 's1', requestId: 'r1', version, lifecycle,
  message: { id: 'm1', content: `v${version}`, contentSegments: [], toolCalls: [], activity: [] }
})

describe('TurnDisplayStore', () => {
  it('只接受单调版本并按 turn 合帧', () => {
    const store = new TurnDisplayStore()
    const applied: string[] = []
    store.subscribe((items) => applied.push(items[0]!.message.content))
    store.enqueue(display(1)); store.enqueue(display(2)); store.enqueue(display(1)); store.flush()
    expect(store.get('t1')?.version).toBe(2)
    expect(applied).toEqual(['v2'])
  })

  it('终态仍保留但不再标记 active', () => {
    const store = new TurnDisplayStore()
    store.enqueue(display(1)); store.flush(); store.enqueue(display(2, 'completed')); store.flush()
    expect(store.get('t1')?.lifecycle).toBe('completed')
    expect(store.activeKnown()).toEqual([])
  })
})
