import { describe, expect, it } from 'vitest'
import { withSessionContextCompactionLock } from '../sessionCompactionLock'
import { classifyAgentSessionStartFailure } from './agentSessionStartFailure'

describe('agent session start failure classification', () => {
  it('parks on a held context compaction lock and classifies the same race as busy after unlock', async () => {
    let release!: () => void
    let announceLock!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const locked = new Promise<void>((resolve) => { announceLock = resolve })
    const sessionId = 'compaction-classification-session'
    const operation = withSessionContextCompactionLock(sessionId, async () => {
      announceLock()
      await held
    })
    await locked

    expect(classifyAgentSessionStartFailure(sessionId, new Error('SESSION_CONTEXT_COMPACTION_BUSY'))).toBe('compaction-busy')
    release()
    await operation
    expect(classifyAgentSessionStartFailure(sessionId, new Error('SESSION_CONTEXT_COMPACTION_BUSY'))).toBe('busy')
  })

  it('keeps policy confirmation waits separate from retryable startup errors', () => {
    expect(classifyAgentSessionStartFailure('s', new Error('AGENT_SESSION_EXECUTION_APPROVAL_WAITING'))).toBe('waiting')
    expect(classifyAgentSessionStartFailure('s', new Error('SESSION_TURN_BUSY'))).toBe('busy')
    expect(classifyAgentSessionStartFailure('s', new Error('configuration failed'))).toBeUndefined()
  })

  it('parks an approved agent input when an earlier runtime-trigger notification owns the FIFO head', () => {
    expect(classifyAgentSessionStartFailure('s', new Error('AGENT_SESSION_QUEUE_HEAD_CHANGED'))).toBe('queue-head-waiting')
  })
})
