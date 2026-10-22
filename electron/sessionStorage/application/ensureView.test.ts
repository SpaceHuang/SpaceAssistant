import { describe, expect, it, vi } from 'vitest'
import { createEnsureView } from './ensureView'

describe('ensureView', () => {
  const ensureView = createEnsureView()
  it('prepares a missing view asynchronously, then reruns the complete selection from a fresh snapshot', async () => {
    let revision = 1
    const snapshots: number[] = []
    const prepare = vi.fn(async () => { revision = 2 })
    const result = await ensureView({
      sessionId: 'session-1', scopeKey: 'chatMessageV1',
      read: () => { snapshots.push(revision); return revision === 1 ? { ready: false as const } : { ready: true as const, value: { revision } } },
      prepare,
    })
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', scopeKey: 'chatMessageV1' })
    expect(snapshots).toEqual([1, 2])
    expect(result).toEqual({ revision: 2 })
  })

  it('awaits verified cache reads before and after preparation', async () => {
    let ready = false
    const reads: boolean[] = []
    const read = vi.fn(async () => {
      reads.push(ready)
      return ready ? { ready: true as const, value: ['verified'] } : { ready: false as const }
    })
    const prepare = vi.fn(async () => { ready = true })
    await expect(ensureView({ sessionId: 's', scopeKey: 'chatBodyV1', read, prepare })).resolves.toEqual(['verified'])
    expect(read).toHaveBeenCalledTimes(2)
    expect(reads).toEqual([false, true])
  })

  it('joins concurrent preparation for the same session and scope', async () => {
    let release!: () => void
    const prepare = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    let completed = false
    const read = () => completed ? ({ ready: true as const, value: 'fresh' }) : ({ ready: false as const })
    const first = ensureView({ sessionId: 's', scopeKey: 'scope', read, prepare })
    const second = ensureView({ sessionId: 's', scopeKey: 'scope', read, prepare })
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
    expect(prepare).toHaveBeenCalledTimes(1)
    completed = true
    release()
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh', 'fresh'])
  })

  it('lets one cancelled caller stop waiting without cancelling shared preparation', async () => {
    let release!: () => void
    let completed = false
    const prepare = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    const read = () => completed ? ({ ready: true as const, value: 'fresh' }) : ({ ready: false as const })
    const cancelled = ensureView({ sessionId: 's', scopeKey: 'scope', read, prepare, signal: controller.signal })
    const waiting = ensureView({ sessionId: 's', scopeKey: 'scope', read, prepare })
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
    controller.abort(new Error('caller cancelled'))
    await expect(cancelled).rejects.toThrow('caller cancelled')
    completed = true
    release()
    await expect(waiting).resolves.toBe('fresh')
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('does not return the old selection when preparation fails', async () => {
    const prepare = vi.fn(async () => { throw new Error('build failed') })
    await expect(ensureView({ sessionId: 's', scopeKey: 'scope', read: () => ({ ready: false as const, value: 'old' }), prepare }))
      .rejects.toThrow('build failed')
  })
})
