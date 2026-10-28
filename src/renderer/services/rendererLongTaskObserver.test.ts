import { describe, expect, it, vi } from 'vitest'
import { projectRendererLongTask, startRendererLongTaskObserver, type RendererLongTaskKind } from './rendererLongTaskObserver'

describe('renderer long task observation', () => {
  it('projects only bounded timing fields for tasks that can affect the 50 ms budget', () => {
    expect(projectRendererLongTask({ startTime: 12.345, duration: 49.99, name: 'private', attribution: [{ name: 'secret' }] }, 'longtask')).toBeUndefined()
    expect(projectRendererLongTask({ startTime: 12.345, duration: 51.234, name: 'private', attribution: [{ name: 'secret' }] }, 'longtask')).toEqual({
      kind: 'longtask', startTimeMs: 12.35, durationMs: 51.23
    })
    expect(projectRendererLongTask({ startTime: 20, duration: 60, blockingDuration: 8.126, scripts: [{ sourceURL: '/private/path.js' }] }, 'long-animation-frame')).toEqual({
      kind: 'long-animation-frame', startTimeMs: 20, durationMs: 60, blockingDurationMs: 8.13,
      scriptAttributionStatus: 'filtered', scriptCandidateCount: 1
    })
    expect(projectRendererLongTask({ startTime: -1, duration: 60 }, 'longtask')).toBeUndefined()
    expect(projectRendererLongTask({ startTime: 1, duration: 600_001 }, 'longtask')).toBeUndefined()
  })

  it('keeps only bounded attribution from packaged renderer assets', () => {
    expect(projectRendererLongTask({
      startTime: 20, duration: 320, blockingDuration: 270,
      scripts: [
        { sourceURL: 'file:///tmp/app/Contents/Resources/app.asar/dist/renderer/assets/main-AbC123.js', sourceFunctionName: 'renderMessageList', duration: 255.126, args: 'private' },
        { sourceURL: 'file:///private/user.js', sourceFunctionName: 'privateUserInput', duration: 80 },
        { sourceURL: 'file:///tmp/app.asar/dist/renderer/assets/vendor-XyZ789.js', sourceFunctionName: 'bad name with spaces', duration: 400 }
      ]
    }, 'long-animation-frame')).toEqual({
      kind: 'long-animation-frame', startTimeMs: 20, durationMs: 320, blockingDurationMs: 270,
      scriptAttributionStatus: 'present', scriptCandidateCount: 3,
      scriptAttributions: [{ file: 'main-AbC123.js', functionName: 'renderMessageList', durationMs: 255.13 }]
    })
    expect(projectRendererLongTask({ startTime: 20, duration: 80 }, 'long-animation-frame')).toMatchObject({
      scriptAttributionStatus: 'unavailable', scriptCandidateCount: 0
    })
    expect(projectRendererLongTask({ startTime: 20, duration: 80, scripts: [{ sourceURL: 'file:///private/user.js', duration: 70 }] }, 'long-animation-frame')).toMatchObject({
      scriptAttributionStatus: 'filtered', scriptCandidateCount: 1
    })
  })

  it('observes supported entry types, filters short work, and disconnects both observers', () => {
    const callbacks: Array<(list: { getEntries: () => readonly unknown[] }) => void> = []
    const disconnect = vi.fn()
    class FakeObserver {
      static supportedEntryTypes = ['longtask', 'long-animation-frame']
      constructor(callback: (list: { getEntries: () => readonly unknown[] }) => void) { callbacks.push(callback) }
      observe = vi.fn()
      disconnect = disconnect
    }
    const emit = vi.fn()
    const stop = startRendererLongTaskObserver({ Observer: FakeObserver, emit })

    expect(callbacks).toHaveLength(2)
    callbacks[0]({ getEntries: () => [{ startTime: 1, duration: 40 }, { startTime: 2, duration: 70 }] })
    callbacks[1]({ getEntries: () => [{ startTime: 3, duration: 80, blockingDuration: 12 }] })
    expect(emit.mock.calls.map(([record]) => record)).toEqual([
      { kind: 'longtask', startTimeMs: 2, durationMs: 70 },
      { kind: 'long-animation-frame', startTimeMs: 3, durationMs: 80, blockingDurationMs: 12,
        scriptAttributionStatus: 'unavailable', scriptCandidateCount: 0 }
    ])
    stop()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('ignores observer setup failures and supports browsers without LoAF', () => {
    const callbackKinds: RendererLongTaskKind[] = []
    class PartialObserver {
      static supportedEntryTypes = ['longtask']
      constructor(_callback: (list: { getEntries: () => readonly unknown[] }) => void) {}
      observe(options: { type: string }) { callbackKinds.push(options.type as RendererLongTaskKind) }
      disconnect = vi.fn()
    }
    const stop = startRendererLongTaskObserver({ Observer: PartialObserver, emit: vi.fn() })
    expect(callbackKinds).toEqual(['longtask'])
    stop()

    class BrokenObserver {
      static supportedEntryTypes = ['longtask']
      constructor(_callback: (list: { getEntries: () => readonly unknown[] }) => void) {}
      observe(): never { throw new Error('unsupported') }
      disconnect = vi.fn()
    }
    expect(() => startRendererLongTaskObserver({ Observer: BrokenObserver, emit: vi.fn() })).not.toThrow()
  })
})
