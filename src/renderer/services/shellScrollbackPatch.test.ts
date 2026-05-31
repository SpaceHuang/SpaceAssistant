import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mergeToolCallScrollback, patchShellTerminalScrollback } from './shellScrollbackPatch'
import type { ToolCallRecord } from '../../shared/domainTypes'

vi.mock('./chatRunnerService', () => ({
  routePatchMessage: vi.fn()
}))

describe('shellScrollbackPatch', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: { chatPatchMessage: vi.fn().mockResolvedValue(undefined) }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('merges terminalScrollback into matching tool call', () => {
    const toolCalls: ToolCallRecord[] = [
      {
        id: 't1',
        toolName: 'run_shell',
        input: { command: 'echo hi' },
        status: 'completed',
        riskLevel: 'medium',
        result: { success: true, data: { stdout: 'hi', exitCode: 0 } }
      }
    ]
    const next = mergeToolCallScrollback(toolCalls, 't1', { cols: 80, rows: 24, serialized: 'snap' })
    const data = next[0]?.result?.data as { terminalScrollback?: { serialized?: string } }
    expect(data.terminalScrollback?.serialized).toBe('snap')
    expect(next[0]?.progressOutputRaw).toBeUndefined()
  })

  it('invokes chatPatchMessage on patch', () => {
    patchShellTerminalScrollback({
      sessionId: 's1',
      messageId: 'm1',
      toolUseId: 't1',
      toolCalls: [
        {
          id: 't1',
          toolName: 'run_shell',
          input: {},
          status: 'completed',
          riskLevel: 'medium'
        }
      ],
      scrollback: { cols: 80, rows: 24, ansiText: 'x' }
    })
    expect(window.api.chatPatchMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        messageId: 'm1',
        patch: expect.objectContaining({ toolCalls: expect.any(Array) })
      })
    )
  })
})
