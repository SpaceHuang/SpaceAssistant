import { describe, expect, it } from 'vitest'
import { assertImOutboundAllowed, classifyImOutbound } from './outboundClassification'

describe('classifyImOutbound', () => {
  const base = {
    channel: 'feishu' as const,
    purpose: 'task-reply' as const,
    originSessionId: 'session-1',
    activeSessionId: 'session-1',
    identityKey: 'chat-1',
    ownerId: 'owner-1',
    recipient: 'chat-1',
    trustedRecipient: 'chat-1',
    chatType: 'p2p' as const,
    content: 'The requested report is ready.',
    contentAssessment: { source: 'host' as const, content: 'The requested report is ready.', classification: 'ordinary' as const, classifierVersion: 'host-outbound-v1' },
    contentCompleteness: 'complete' as const,
    hasAttachment: false,
    attachmentAuthorized: false
  }

  it('classifies a complete ordinary reply to the current authenticated owner as controlled reply', () => {
    expect(classifyImOutbound(base)).toMatchObject({ kind: 'controlled-reply', recipient: 'chat-1' })
  })

  it.each([
    ['third-party recipient', { recipient: 'other-user' }],
    ['group destination', { chatType: 'group' }],
    ['sensitive content', { contentAssessment: { source: 'host', content: 'The requested report is ready.', classification: 'sensitive', classifierVersion: 'host-outbound-v1' } }],
    ['bulk local export', { contentAssessment: { source: 'host', content: 'The requested report is ready.', classification: 'bulk-local-export', classifierVersion: 'host-outbound-v1' } }],
    ['permission change', { contentAssessment: { source: 'host', content: 'The requested report is ready.', classification: 'permission-change', classifierVersion: 'host-outbound-v1' } }],
    ['private query', { contentAssessment: { source: 'host', content: 'The requested report is ready.', classification: 'private-query', classifierVersion: 'host-outbound-v1' } }],
    ['upload', { contentAssessment: { source: 'host', content: 'The requested report is ready.', classification: 'upload', classifierVersion: 'host-outbound-v1' } }],
    ['unauthorized attachment', { hasAttachment: true }],
    ['changed attachment', { hasAttachment: true, attachmentAuthorized: true, attachmentContentVersion: 'v2', checkedAttachmentContentVersion: 'v1' }],
    ['stale session', { activeSessionId: 'session-2' }],
    ['unclassified content', { contentCompleteness: 'unknown' }]
  ] as const)('classifies %s outside the controlled reply exception', (_label, override) => {
    expect(classifyImOutbound({ ...base, ...override })).not.toMatchObject({ kind: 'controlled-reply' })
  })

  it('does not trust a model recipient for a system reply', () => {
    expect(classifyImOutbound({ ...base, purpose: 'system-reply', modelRecipient: 'other-user' })).toMatchObject({
      kind: 'active-outbound', reason: 'untrusted-recipient'
    })
  })

  it('rejects host content facts when the outgoing body changes after classification', () => {
    expect(classifyImOutbound({ ...base, content: 'The report now includes private records.' })).toMatchObject({
      kind: 'active-outbound', reason: 'unknown-content'
    })
  })
  it('requires a user confirmation receipt bound to the exact active-send facts', () => {
    const facts = { ...base, purpose: 'active-send' as const, recipient: 'third-party', trustedRecipient: undefined,
      contentAssessment: { source: 'host' as const, content: base.content, classification: 'ordinary' as const, classifierVersion: 'host-v1' } }
    expect(() => assertImOutboundAllowed(facts, { channel: 'feishu', body: base.content, sessionId: 'session-1', recipient: 'third-party' }))
      .toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
    expect(() => assertImOutboundAllowed({ ...facts, userConfirmationReceipt: 'receipt-1' },
      { channel: 'feishu', body: base.content, sessionId: 'session-1', recipient: 'third-party' })).not.toThrow()
    expect(() => assertImOutboundAllowed({ ...facts, userConfirmationReceipt: 'receipt-1' },
      { channel: 'feishu', body: 'changed body', sessionId: 'session-1', recipient: 'third-party' }))
      .toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
  })

})
