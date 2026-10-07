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
})
