import { describe, expect, it, vi } from 'vitest'
import {
  emitRendererSessionSwitchTrace,
  recordRendererSessionSelection,
  requestChatMessagePageWithTraceMetadata,
  takeRendererSessionSelectionDuration
} from './sessionSwitchTrace'
import { readSessionSwitchTraceMetadata } from '../../shared/sessionSwitchTraceMetadata'

describe('renderer session switch trace', () => {
  it('records a changed session selection once without exposing the session id', () => {
    recordRendererSessionSelection('session-b', 'session-a', 100)
    expect(takeRendererSessionSelectionDuration('session-a', 110)).toBeUndefined()
    expect(takeRendererSessionSelectionDuration('session-b', 125)).toBe(25)
    expect(takeRendererSessionSelectionDuration('session-b', 130)).toBeUndefined()
  })

  it('does not start a timing marker for selecting the already active session', () => {
    recordRendererSessionSelection('session-a', 'session-a', 100)
    expect(takeRendererSessionSelectionDuration('session-a', 120)).toBeUndefined()
  })

  it('attaches request ordinal after the contextBridge response reaches the renderer world', async () => {
    const page = { entries: [] }
    const result = await requestChatMessagePageWithTraceMetadata(async () => page)
    expect(result).toBe(page)
    expect(readSessionSwitchTraceMetadata(result)).toEqual({ requestOrdinal: expect.any(Number) })
  })

  it('emits only bounded timings and the shared renderer correlation key', () => {
    const emit = vi.fn()
    emitRendererSessionSwitchTrace({ metadata: { processId: 44, requestOrdinal: 8 }, outcome: 'ok', pageSize: 20,
      stages: [
        { name: 'selection-to-page-request', durationMs: 4.5, outcome: 'ok' },
        { name: 'renderer-page-request', durationMs: 10.126, outcome: 'ok' },
        { name: 'private-user-body', durationMs: 5, outcome: 'ok' },
      ], emit })
    expect(JSON.parse(emit.mock.calls[0]![0]!)).toEqual({
      event: 'session.switch.trace', instance: 'renderer', rendererProcessId: 44, requestOrdinal: 8,
      outcome: 'ok', pageSize: 20, stages: [
        { name: 'selection-to-page-request', durationMs: 4.5, outcome: 'ok' },
        { name: 'renderer-page-request', durationMs: 10.13, outcome: 'ok' }
      ]
    })
  })

  it('uses the exact private prefix consumed by the main console-message listener', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    emitRendererSessionSwitchTrace({ metadata: { processId: 2, requestOrdinal: 1 }, outcome: 'ok', pageSize: 0, stages: [] })
    expect(info).toHaveBeenCalledOnce()
    expect(String(info.mock.calls[0]![0])).toMatch(/^\[session\.switch\.trace\.renderer\] \{"event":"session\.switch\.trace"/)
    info.mockRestore()
  })

  it('lets the main process provide the renderer id without changing the console payload schema', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    emitRendererSessionSwitchTrace({ metadata: { requestOrdinal: 3 }, outcome: 'ok', pageSize: 1, stages: [] })
    const logged = JSON.parse(String(info.mock.calls.at(-1)?.[0]).replace('[session.switch.trace.renderer] ', ''))
    expect(logged).not.toHaveProperty('rendererProcessId')
    expect(logged.requestOrdinal).toBe(3)
    info.mockRestore()
  })
})
