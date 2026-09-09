import { describe, expect, it, vi } from 'vitest'
import { cleanupPersistedOrphansOnStartup } from './startupOrphanCleanup'

describe('cleanupPersistedOrphansOnStartup', () => {
  it('只处理 active turn 中带 owner identity 的 executing run_shell，并记录审计结果', async () => {
    const cleanup = vi.fn().mockResolvedValue('cleaned')
    const audit = vi.fn()
    const result = await cleanupPersistedOrphansOnStartup({
      listTurns: () => [
        { turnId: 't1', requestId: 'r1', sessionId: 's1', userMessageId: 'u1', assistantMessageId: 'a1', state: 'executing', version: 1 } as never,
        { turnId: 't2', requestId: 'r2', sessionId: 's1', userMessageId: 'u2', assistantMessageId: 'a2', state: 'terminal', version: 1 } as never
      ],
      getMessage: (id) => id === 'a1' ? { id, sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming', schemaVersion: 1, toolCalls: [
        { id: 'tool-1', toolName: 'run_shell', input: {}, status: 'executing', riskLevel: 'high', processPid: 42, processGroupId: 42, processOwnerToken: 'owner' },
        { id: 'tool-2', toolName: 'run_shell', input: {}, status: 'executing', riskLevel: 'high', processPid: 43 }
      ] } : undefined,
      cleanup,
      audit
    })
    expect(result).toBe(1)
    expect(cleanup).toHaveBeenCalledWith({ pid: 42, processGroupId: 42, ownerToken: 'owner' })
    expect(audit).toHaveBeenCalledWith({ turnId: 't1', toolUseId: 'tool-1', result: 'cleaned' })
  })
})
