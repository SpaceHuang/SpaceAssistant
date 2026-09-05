import { describe, expect, it, vi } from 'vitest'
import { ConfirmationAuthorizationRegistry } from './confirmationAuthorizationRegistry'
import { recordUserAnswerFromDecision, recordUserAnswerToCacheWithPermit } from './decisionCacheWriter'
import type { Decision } from '../../src/shared/confirmation/types'

const subject = {
  invocationId: 'inv', requestId: 'req', toolUseId: 'tool', sessionId: 'session',
  planDigest: 'plan', factsDigest: 'facts', revision: 'rev'
}

describe('recordUserAnswerToCacheWithPermit', () => {
  it('requires and consumes the confirmation permit before writing', () => {
    const registry = new ConfirmationAuthorizationRegistry()
    const permit = registry.issue(subject)
    const writer = vi.fn()
    expect(() => recordUserAnswerToCacheWithPermit({} as never, registry, permit, subject)).toThrow()
    // The permit is consumed before the downstream writer can be retried with a different key.
    expect(() => registry.consume(permit, subject)).toThrow('MEMORY_WRITE_PERMIT_INVALID')
    expect(writer).not.toHaveBeenCalled()
  })
})

describe('recordUserAnswerFromDecision', () => {
  const decision: Extract<Decision, { type: 'require-confirm' }> = {
    type: 'require-confirm', ruleId: 'r', riskLevel: 'medium',
    facts: { toolName: 'run_shell', actionClass: 'execute', baseRiskLevel: 'medium', signals: [], summary: { text: 'x' } },
    memoryTiers: [{ key: { kind: 'shell-command', verb: 'echo', level: 'exact' }, label: '记住 echo' }],
    timeoutMs: null
  }
  const args = (key: Decision['type'] extends never ? never : { kind: 'shell-command'; verb: string; level: 'exact' }) => ({
    db: {} as never, lane: 'desktop' as const, sessionId: 's', key, decision,
    source: 'user-confirm' as const
  })

  it('rejects a key not offered by the confirmed decision', () => {
    expect(() => recordUserAnswerFromDecision(args({ kind: 'shell-command', verb: 'rm', level: 'exact' }))).toThrow('MEMORY_WRITE_KEY_NOT_IN_DECISION')
  })

  it('rejects decisions with no memory tiers', () => {
    expect(() => recordUserAnswerFromDecision({ ...args(decision.memoryTiers[0]!.key), decision: { ...decision, memoryTiers: [] } })).toThrow('MEMORY_WRITE_NOT_ALLOWED')
  })
})
