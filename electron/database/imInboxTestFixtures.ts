/** Test-only fixture adapter for legacy scenario tests that do not exercise IM identity semantics. */
import type { AppDatabase } from './sqliteStore'
import {
  appendImInboxMessage as appendRaw,
  appendImInboxMessageWithWakeEvent as appendWithWakeRaw,
  parkImInboxMessageForClarification as parkRaw,
  type AppendImInboxMessageInput,
  type ParkImInboxMessageInput
} from './imInbox'

type Identity = Pick<AppendImInboxMessageInput, 'accountId' | 'conversationId' | 'senderId'>
type FixtureInput<T extends { sessionId: string }> = Omit<T, keyof Identity> & Partial<Identity>
const withIdentity = <T extends { sessionId: string }>(input: FixtureInput<T>): T => ({
  ...input,
  accountId: input.accountId ?? 'fixture-account',
  conversationId: input.conversationId ?? input.sessionId,
  senderId: input.senderId ?? 'fixture-sender'
} as unknown as T)

export function appendImInboxMessage(db: AppDatabase, input: FixtureInput<AppendImInboxMessageInput>) {
  return appendRaw(db, withIdentity(input))
}

export function appendImInboxMessageWithWakeEvent(db: AppDatabase, input: FixtureInput<AppendImInboxMessageInput>) {
  return appendWithWakeRaw(db, withIdentity(input))
}

export function parkImInboxMessageForClarification(db: AppDatabase, input: FixtureInput<ParkImInboxMessageInput>) {
  return parkRaw(db, withIdentity(input))
}

export * from './imInbox'
