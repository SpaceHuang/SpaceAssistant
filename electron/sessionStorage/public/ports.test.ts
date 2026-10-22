import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SessionCommands, SessionQueries, SessionHistoryPort } from './ports'
import type { HistoryPort } from '../../../packages/agent-sdk/src/history'

describe('public session command port', () => {
  it('binds session mutations to explicit session identities and message DTOs', () => {
    expectTypeOf<Parameters<SessionCommands['deleteSession']>[0]>().toEqualTypeOf<string>()
    expectTypeOf<Parameters<SessionCommands['appendNonTurnMessage']>[0]['id']>().toEqualTypeOf<string>()
    expectTypeOf<ReturnType<SessionCommands['createSession']>['id']>().toEqualTypeOf<string>()
    expect(true).toBe(true)
  })

  it('keeps the read port session-scoped and returns recovery facts as a public data shape', () => {
    expectTypeOf<Parameters<SessionQueries['readChatPage']>[0]['sessionId']>().toEqualTypeOf<string>()
    type RecoveryEffect = ReturnType<SessionQueries['continuationSources']['readRecoveryFacts']>['unresolvedEffects'][number]
    expectTypeOf<RecoveryEffect['id']>().toEqualTypeOf('id' as string)
    expectTypeOf<RecoveryEffect['originInvocationId']>().toEqualTypeOf('invocation' as string)
    expectTypeOf<RecoveryEffect['toolCallId']>().toEqualTypeOf('tool' as string)
    expect(true).toBe(true)
  })

  it('extends the SDK History capability without exposing a database handle', () => {
    expectTypeOf(null as unknown as SessionHistoryPort).toMatchTypeOf<HistoryPort>()
    expectTypeOf<Parameters<SessionHistoryPort['readLatestInvocationForSession']>[0]>().toEqualTypeOf('session' as string)
    expect(true).toBe(true)
  })
})
