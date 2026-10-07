import type { Message } from '../../src/shared/domainTypes'
import type { PersistedTurn } from '../database'
import type { AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { TurnExecutionConfig } from '../../src/shared/assistantFactAggregator'
import type { SessionExecutionStore } from '../sessionStorage/contracts'

/** Compatibility adapter: acceptance identity and transcript CAS are owned by SessionExecutionStore. */
export function createAcceptedTurnFromPrepared(
  prepared: { turnId: string; requestId: string; sessionId: string; startToken: string; userMessage?: Pick<Message, 'id'> },
  lane: NonNullable<TurnExecutionConfig['lane']>,
  config: TurnExecutionConfig,
  execution: SessionExecutionStore
): AcceptedTurn {
  return execution.acceptPrepared({ prepared, lane, config })
}

/** Compatibility adapter for older call sites; callers should inject the execution port. */
export function loadAcceptedTurnMessages(
  turn: PersistedTurn,
  execution: SessionExecutionStore
): Message[] {
  return execution.loadAcceptedMessages({ sessionId: turn.sessionId, turnId: turn.turnId })
}
