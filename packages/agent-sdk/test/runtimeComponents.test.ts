import { describe, expect, it } from 'vitest'
import { TOOL_REQUEST_LANES, ToolRevocationRegistry } from '../src/runtime/components'

describe('ToolRevocationRegistry', () => {
  it('publishes lane-specific revocations synchronously and includes automation in global revocation', () => {
    const registry = new ToolRevocationRegistry()
    expect(TOOL_REQUEST_LANES).toEqual(['desktop', 'feishu', 'wechat', 'automation'])
    registry.registerToolRevocationRequest('automation-request', 'automation')
    const events: Array<{ requestId: string; lane: string; toolName: string }> = []
    registry.onRevocation((event) => events.push(event))

    expect(registry.revokeToolForAllLanes('write_file')).toBe(1)
    expect(registry.isToolRevoked('automation-request', 'write_file')).toBe(true)
    expect(events).toEqual([{ requestId: 'automation-request', lane: 'automation', toolName: 'write_file' }])
  })

  it('revokes and notifies every lane before surfacing a listener failure', () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('desktop-request', 'desktop')
    registry.registerToolRevocationRequest('automation-request', 'automation')
    const events: Array<{ requestId: string; lane: string; toolName: string }> = []
    registry.onRevocation((event) => {
      events.push(event)
      if (event.lane === 'desktop') throw new Error('desktop revocation observer failed')
    })

    expect(() => registry.revokeToolForAllLanes('write_file')).toThrow(AggregateError)
    expect(registry.isToolRevoked('desktop-request', 'write_file')).toBe(true)
    expect(registry.isToolRevoked('automation-request', 'write_file')).toBe(true)
    expect(events).toEqual([
      { requestId: 'desktop-request', lane: 'desktop', toolName: 'write_file' },
      { requestId: 'automation-request', lane: 'automation', toolName: 'write_file' }
    ])
  })
})
