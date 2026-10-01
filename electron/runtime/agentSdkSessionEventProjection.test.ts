import { describe, expect, it, vi } from 'vitest'
import type { SessionEventSink } from '../sessionEvents'
import { createAgentSdkSessionEventProjector } from './agentSdkSessionEventProjection'

describe('createAgentSdkSessionEventProjector', () => {
  it('rejects a failed critical projection after recording the persistence diagnostic', async () => {
    const error = new Error('tool-call ledger unavailable')
    const appendCritical = vi.fn(async () => { throw error })
    const onCriticalFailure = vi.fn()
    const projector = createAgentSdkSessionEventProjector({
      turnId: 'turn-1', eventWriter: { appendCritical } as unknown as SessionEventSink,
      onCriticalFailure, failClosedCriticalEvents: true
    })

    await expect(projector({ type: 'tool_call', payload: { toolUseId: 'tool-1' } })).rejects.toBe(error)
    expect(onCriticalFailure).toHaveBeenCalledWith(error)
  })

  it('records but does not throw critical append failures in legacy compatibility mode', async () => {
    const error = new Error('legacy ledger unavailable')
    const onCriticalFailure = vi.fn()
    const projector = createAgentSdkSessionEventProjector({
      turnId: 'turn-1', eventWriter: { appendCritical: vi.fn(async () => { throw error }) } as unknown as SessionEventSink,
      onCriticalFailure
    })

    await expect(projector({ type: 'tool_call', payload: { toolUseId: 'tool-1' } })).resolves.toBeUndefined()
    expect(onCriticalFailure).toHaveBeenCalledWith(error)
  })

  it('keeps assistant chunks droppable while preserving the normalized turn projection', async () => {
    const appendChunk = vi.fn()
    const projector = createAgentSdkSessionEventProjector({
      turnId: 'turn-1', eventWriter: {
        waitForCapacity: vi.fn(async () => undefined), appendChunk
      } as unknown as SessionEventSink
    })

    await projector({ type: 'assistant_chunk', payload: { delta: { type: 'tool_call_delta', partialJson: '{"secret":"x"}' } } })
    expect(appendChunk).toHaveBeenCalledWith({
      type: 'assistant_chunk', payload: { turnId: 'turn-1', delta: { type: 'tool_call_delta', partialJson: '' } }
    })
  })

  it('counts and swallows an assistant chunk capacity failure', async () => {
    const onChunkDropped = vi.fn()
    const appendChunk = vi.fn()
    const projector = createAgentSdkSessionEventProjector({
      turnId: 'turn-1', eventWriter: {
        waitForCapacity: vi.fn(async () => { throw new Error('backpressure') }), appendChunk
      } as unknown as SessionEventSink,
      onChunkDropped
    })

    await expect(projector({ type: 'assistant_chunk', payload: {} })).resolves.toBeUndefined()
    expect(onChunkDropped).toHaveBeenCalledOnce()
    expect(appendChunk).not.toHaveBeenCalled()
  })
})
