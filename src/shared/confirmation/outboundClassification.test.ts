import { describe, expect, it } from 'vitest'
import { assertImOutboundAllowed } from './outboundClassification'

describe('outbound evidence equivalence', () => {
  it('structured facts observations classify evidence without authorizing dispatch', async () => {
    const { createImOutboundFacts } = await import('./imOutboundFacts')
    const ordinary = await createImOutboundFacts('The requested report is ready.')
    const sensitive = await createImOutboundFacts('token=sk-1234567890abcdefghijklmnop')
    expect(ordinary.evidenceKinds).toEqual([])
    expect(sensitive.evidenceKinds).toContain('credential-like-pattern')
  })
})

describe('assertImOutboundAllowed', () => {
  const base = {
    channel: 'feishu' as const,
    purpose: 'active-send' as const,
    originSessionId: 'session-1',
    activeSessionId: 'session-1',
    identityKey: 'chat-1',
    ownerId: 'owner-1',
    recipient: 'third-party',
    trustedRecipient: undefined,
    chatType: 'p2p' as const,
    content: 'The requested report is ready.',
    contentAssessment: { source: 'host' as const, content: 'The requested report is ready.', classification: 'ordinary' as const, classifierVersion: 'host-outbound-v1' },
    contentCompleteness: 'complete' as const,
    hasAttachment: false,
    attachmentAuthorized: false
  }

  it('checks only that dispatch matches the approved object', () => {
    expect(() => assertImOutboundAllowed(base, { channel: 'feishu', body: base.content, sessionId: 'session-1', recipient: 'third-party' }))
      .not.toThrow()
    expect(() => assertImOutboundAllowed({ ...base, userConfirmationReceipt: 'receipt-1' },
      { channel: 'feishu', body: base.content, sessionId: 'session-1', recipient: 'third-party' })).not.toThrow()
    expect(() => assertImOutboundAllowed({ ...base, userConfirmationReceipt: 'receipt-1' },
      { channel: 'feishu', body: 'changed body', sessionId: 'session-1', recipient: 'third-party' }))
      .toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
  })
})
