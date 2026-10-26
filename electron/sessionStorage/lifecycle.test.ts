import { describe, expect, it, vi } from 'vitest'
import { createStorageLifecycleControl } from './lifecycle'

describe('host-only storage lifecycle control', () => {
  it('stops accepting schedules and waits for active work before reporting quiescent', async () => {
    let finish!: () => void
    const activeWork = new Promise<void>((resolve) => { finish = resolve })
    const lifecycle = createStorageLifecycleControl({
      tasks: [{ taskId: 'test-task', category: 'pending-reclamation', start: vi.fn(() => ({ stop: vi.fn(), quiesce: () => activeWork })) }]
    })
    lifecycle.requestMaintenance({ reason: 'window-ready' })
    const stopping = lifecycle.stop({ deadlineMs: 100 })
    expect(lifecycle.requestMaintenance({ reason: 'retry' })).toEqual({ status: 'not-needed' })
    finish()
    await expect(stopping).resolves.toEqual({ status: 'quiescent' })
  })


  it('starts and owns a foreground projection preparation through quiescence', async () => {
    let finish!: () => void
    const active = new Promise<void>((resolve) => { finish = resolve })
    const prepare = vi.fn(async () => { await active })
    const stop = vi.fn()
    const start = vi.fn(() => ({ stop, quiesce: async () => { await active } }))
    const lifecycle = createStorageLifecycleControl({ tasks: [{ taskId: 'projection-build', category: 'derived-index', start, prepare }] })
    const request = { sessionId: 'session-1', scopeKey: 'chatMessageV1', specVersion: 1 }
    const preparation = lifecycle.prepareProjection(request)
    expect(start).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledExactlyOnceWith(request)
    const stopping = lifecycle.stop({ deadlineMs: 100 })
    expect(stop).toHaveBeenCalledOnce()
    finish()
    await expect(preparation).resolves.toBeUndefined()
    await expect(stopping).resolves.toEqual({ status: 'quiescent' })
  })

  it('does not claim maintenance is scheduled before background work is authorized', () => {
    const start = vi.fn(() => ({ stop: vi.fn(), quiesce: async () => undefined }))
    const lifecycle = createStorageLifecycleControl({ tasks: [{ taskId: 'test-task', category: 'pending-reclamation', start }] })
    expect(lifecycle.requestMaintenance({ reason: 'window-ready' })).toEqual({ status: 'not-needed' })
    expect(start).not.toHaveBeenCalled()
  })

  it('starts existing maintenance only after authorization and starts it once', () => {
    const start = vi.fn(() => ({ stop: vi.fn(), quiesce: async () => undefined }))
    const lifecycle = createStorageLifecycleControl({ tasks: [{ taskId: 'test-task', category: 'pending-reclamation', start }] })
    expect(lifecycle.requestMaintenance({ reason: 'window-ready' })).toEqual({ status: 'not-needed' })
    lifecycle.allowBackgroundWork()
    expect(start).toHaveBeenCalledTimes(1)
    lifecycle.allowBackgroundWork()
    expect(start).toHaveBeenCalledTimes(1)
  })


  it('pauses and resumes only tasks in the requested maintenance category and reports their state', async () => {
    const pendingStart = vi.fn(() => ({ stop: vi.fn(), quiesce: async () => undefined }))
    const retentionStart = vi.fn(() => ({ stop: vi.fn(), quiesce: async () => undefined }))
    const lifecycle = createStorageLifecycleControl({ tasks: [
      { taskId: 'spill-gc', category: 'pending-reclamation', start: pendingStart },
      { taskId: 'content-cleanup', category: 'retention', start: retentionStart }
    ] })
    lifecycle.allowBackgroundWork()
    await lifecycle.pauseMaintenance({ category: 'pending-reclamation' })
    expect(lifecycle.inspectMaintenance()).toEqual([
      { taskId: 'spill-gc', category: 'pending-reclamation', status: 'paused', scannedCount: 0, processedCount: 0 },
      { taskId: 'content-cleanup', category: 'retention', status: 'scheduled', scannedCount: 0, processedCount: 0 }
    ])
    expect(pendingStart.mock.results[0]?.value.stop).toHaveBeenCalledOnce()
    expect(retentionStart.mock.results[0]?.value.stop).not.toHaveBeenCalled()
    lifecycle.resumeMaintenance({ category: 'pending-reclamation' })
    expect(pendingStart).toHaveBeenCalledTimes(2)
    expect(retentionStart).toHaveBeenCalledOnce()
  })

  it('reports deadline exhaustion while maintenance remains active', async () => {
    const lifecycle = createStorageLifecycleControl({ tasks: [{ taskId: 'test-task', category: 'pending-reclamation', start: () => ({ stop() {}, quiesce: () => new Promise<void>(() => {}) }) }] })
    lifecycle.allowBackgroundWork()
    await expect(lifecycle.stop({ deadlineMs: 1 })).resolves.toEqual({ status: 'deadline-exceeded' })
  })

  it('forwards coalesced policy and capacity wakeups to an active task handle', () => {
    const request = vi.fn()
    const lifecycle = createStorageLifecycleControl({ tasks: [{ taskId: 'wakeable', category: 'retention', start: () => ({ stop() {}, quiesce: async () => undefined, request }) }] })
    lifecycle.allowBackgroundWork()
    expect(lifecycle.requestMaintenance({ reason: 'capacity-pressure', category: 'retention' })).toEqual({ status: 'coalesced' })
    expect(request).toHaveBeenCalledWith('capacity-pressure')
  })

  it('can wake one derived-index task without waking unrelated projection work', () => {
    const bodySourceRequest = vi.fn()
    const projectionRequest = vi.fn()
    const lifecycle = createStorageLifecycleControl({ tasks: [
      { taskId: 'session-body-source-backfill', category: 'derived-index', start: () => ({ stop() {}, quiesce: async () => undefined, request: bodySourceRequest }) },
      { taskId: 'session-projection-build', category: 'derived-index', start: () => ({ stop() {}, quiesce: async () => undefined, request: projectionRequest }) }
    ] })
    lifecycle.allowBackgroundWork()

    expect(lifecycle.requestMaintenance({ reason: 'scope-changed', taskId: 'session-body-source-backfill' })).toEqual({ status: 'coalesced' })
    expect(bodySourceRequest).toHaveBeenCalledWith('scope-changed')
    expect(projectionRequest).not.toHaveBeenCalled()
    void lifecycle.stop({ deadlineMs: 100 })
  })

  it('isolates synchronous start failures and retries only the failed task', async () => {
    vi.useFakeTimers()
    try {
      const handle = { stop: vi.fn(), quiesce: async () => undefined }
      const first = vi.fn().mockImplementationOnce(() => { throw new Error('startup failure') }).mockReturnValue(handle)
      const second = vi.fn(() => ({ stop: vi.fn(), quiesce: async () => undefined }))
      const lifecycle = createStorageLifecycleControl({ tasks: [
        { taskId: 'first', category: 'derived-index', start: first },
        { taskId: 'second', category: 'retention', start: second }
      ] })
      lifecycle.allowBackgroundWork()
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(lifecycle.inspectMaintenance()[0]).toMatchObject({ status: 'failed', lastErrorCode: 'Error' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(first).toHaveBeenCalledTimes(2)
      expect(lifecycle.inspectMaintenance()[0]?.status).toBe('scheduled')
      await lifecycle.stop({ deadlineMs: 10 })
    } finally { vi.useRealTimers() }
  })
})
