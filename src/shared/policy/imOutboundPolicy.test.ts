import { describe, expect, it } from 'vitest'
import { createHostImOutboundFacts } from '../confirmation/outboundClassification'
import { decideSystemImOutbound } from './imOutboundPolicy'

describe('system IM outbound policy', () => {
  it('allows complete ordinary owner replies with a traceable rule', () => {
    const facts = createHostImOutboundFacts({ channel: 'feishu', body: 'The requested report is ready.',
      sessionId: 'session-1', identityKey: 'owner-1', ownerId: 'owner-1', recipient: 'owner-1', chatType: 'p2p' })

    expect(decideSystemImOutbound(facts)).toEqual({ type: 'allow', ruleId: 'im-system-reply-ordinary' })
  })

  it.each([
    ['sensitive', 'access_token=abcdef0123456789abcdef0123456789'],
    ['bulk export', 'Export all customer records'],
    ['permission change', 'permission change'],
    ['incomplete', '']
  ])('denies %s system content with a traceable rule', (_label, body) => {
    const facts = createHostImOutboundFacts({ channel: 'wechat', body,
      sessionId: 'session-1', identityKey: 'owner-1', ownerId: 'owner-1', recipient: 'owner-1', chatType: 'p2p' })

    expect(decideSystemImOutbound(facts)).toMatchObject({ type: 'deny', ruleId: 'im-system-reply-review-required' })
  })

  it('rejects a non-system invocation so user outbound remains under the normal policy gate', () => {
    const facts = createHostImOutboundFacts({ channel: 'wechat', purpose: 'active-send', body: 'hello',
      sessionId: 'session-1', identityKey: 'owner-1', ownerId: 'owner-1', recipient: 'owner-1', chatType: 'p2p' })

    expect(decideSystemImOutbound(facts)).toMatchObject({ type: 'not-applicable' })
  })
})
