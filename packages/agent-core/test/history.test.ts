import { describe, expect, it } from 'vitest'
import { MemoryHistory, rebuildInvocationStates, type HistoryEvent } from '../src/history'

const event = (eventId: string): HistoryEvent => ({ eventId, kind: 'approval-updated', payload: { eventId } })

describe('History Port semantics', () => {
  it('appends with expectedVersion and makes replay idempotent', async () => {
    const history = new MemoryHistory()
    await expect(history.append(event('e1'), 0)).resolves.toEqual({ version: 1, duplicate: false })
    await expect(history.append(event('e1'), 0)).resolves.toEqual({ version: 1, duplicate: true })
    await expect(history.read()).resolves.toEqual({ version: 1, events: [event('e1')] })
  })

  it('rejects version conflicts instead of silently overwriting facts', async () => {
    const history = new MemoryHistory()
    await history.append(event('e1'), 0)
    await expect(history.append(event('e2'), 0)).rejects.toMatchObject({ code: 'version-conflict' })
  })

  it('rebuilds parked invocations as interrupted after restart', async () => {
    const history = new MemoryHistory()
    await history.append({ eventId: 'park-1', kind: 'invocation-parked', payload: { invocationId: 'inv-1' } }, 0)
    const rebuilt = rebuildInvocationStates(await history.read())
    expect(rebuilt.get('inv-1')).toMatchObject({ state: 'interrupted', invocationId: 'inv-1' })
  })
})
