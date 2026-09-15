import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mergeToolCallScrollback, patchShellTerminalScrollback } from './shellScrollbackPatch'
import type { ToolCallRecord } from '../../shared/domainTypes'

vi.mock('./chatRunnerService', () => ({
  routePatchMessage: vi.fn()
}))

describe('shellScrollbackPatch', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: { messagePatchNonTurn: vi.fn().mockResolvedValue(undefined) }
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
        progressOutputRaw: 'cmF3',
        progressOutputRawLabel: 'gbk',
        result: { success: true, data: { stdout: 'hi', exitCode: 0 } }
      }
    ]
    const next = mergeToolCallScrollback(toolCalls, 't1', { cols: 80, rows: 24, serialized: 'snap' })
    const data = next[0]?.result?.data as { terminalScrollback?: { serialized?: string } }
    expect(data.terminalScrollback?.serialized).toBe('snap')
    expect(next[0]?.progressOutputRaw).toBeUndefined()
    // MINOR：编码标签属于 executing 内存字段，完成后必须一并清除
    expect(next[0]?.progressOutputRawLabel).toBeUndefined()
  })

  it('preserves progress fields while tool is still executing', () => {
    const toolCalls: ToolCallRecord[] = [
      {
        id: 't1',
        toolName: 'run_shell',
        input: { command: 'npm install' },
        status: 'executing',
        riskLevel: 'medium',
        progressOutputRaw: 'cmF3',
        progressOutputRawLabel: 'utf-16le',
        progressSeq: 3
      }
    ]
    const next = mergeToolCallScrollback(toolCalls, 't1', { cols: 80, rows: 24, serialized: 'snap' })
    expect(next[0]?.progressOutputRaw).toBe('cmF3')
    expect(next[0]?.progressOutputRawLabel).toBe('utf-16le')
    expect(next[0]?.progressSeq).toBe(3)
  })

  it('invokes messagePatchNonTurn on patch', () => {
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
    expect(window.api.messagePatchNonTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        messageId: 'm1',
        patch: expect.objectContaining({ toolCalls: expect.any(Array) })
      })
    )
  })
})
