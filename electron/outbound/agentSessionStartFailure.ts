import { isSessionContextCompactionLocked } from '../sessionCompactionLock'

export type AgentSessionStartFailure = 'busy' | 'compaction-busy' | 'waiting'

/** Keep the lock-specific wait distinct so drain retries resume on unlock, not ticket release. */
export function classifyAgentSessionStartFailure(sessionId: string, error: unknown): AgentSessionStartFailure | undefined {
  const code = error instanceof Error ? error.message : String(error)
  // The desktop drainer leaves runtime-trigger notifications to trigger recovery.
  // An earlier trigger owns the persisted FIFO head, so wait for that queue transition.
  if (code === 'AGENT_SESSION_QUEUE_HEAD_CHANGED') return 'waiting'
  if (code === 'SESSION_CONTEXT_COMPACTION_BUSY' && isSessionContextCompactionLocked(sessionId)) return 'compaction-busy'
  if (['SESSION_TURN_BUSY', 'SESSION_CONTEXT_COMPACTION_BUSY', 'SESSION_EXECUTION_ACTIVE',
    'SESSION_EXECUTION_ACTIVE_OWNER'].includes(code)) return 'busy'
  if (code.startsWith('AGENT_SESSION_EXECUTION_APPROVAL_')) return 'waiting'
  return undefined
}
