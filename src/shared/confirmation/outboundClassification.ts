import { classifyImOutboundContent, type ImOutboundContentClass, type ImOutboundContentFacts } from './imOutboundFacts'

export type { ImOutboundContentClass } from './imOutboundFacts'
export type ImOutboundChannel = 'wechat' | 'feishu'

export interface ImOutboundFacts {
  channel: ImOutboundChannel
  purpose: 'task-reply' | 'system-reply' | 'active-send' | 'media' | 'retry'
  originSessionId?: string
  activeSessionId?: string
  identityKey?: string
  ownerId?: string
  trustedRecipient?: string
  recipient?: string
  modelRecipient?: string
  chatType?: 'p2p' | 'group' | 'unknown'
  content?: string
  contentFacts?: ImOutboundContentFacts
  contentAssessment?: Readonly<{
    source: 'host'
    content: string
    classification: ImOutboundContentClass
    classifierVersion: string
  }>
  contentCompleteness: 'complete' | 'unknown'
  hasAttachment: boolean
  attachmentAuthorized: boolean
  /** Host inspection says a binary attachment needs a human decision for this prepared call. */
  attachmentApprovalRequired?: boolean
  attachmentContentVersion?: string
  checkedAttachmentContentVersion?: string
  attachmentPath?: string
  checkedAttachmentPath?: string
  userConfirmationReceipt?: string
  destinationId?: string
}


export function assessImOutboundContent(body: string): ImOutboundContentClass {
  return classifyImOutboundContent(body)
}

export function createHostImOutboundFacts(input: {
  channel: ImOutboundChannel
  purpose?: ImOutboundFacts['purpose']
  body: string
  sessionId: string
  identityKey: string
  ownerId: string
  recipient: string
  chatType?: ImOutboundFacts['chatType']
  destinationId?: string
}): ImOutboundFacts {
  return bindImOutboundAssessment({ ...input, purpose: input.purpose ?? 'system-reply',
    classification: assessImOutboundContent(input.body), classifierVersion: 'host-im-outbound-v1' })
}

/** Bind a host-reviewed outbound decision to its exact text, recipient and session. */
export function bindImOutboundAssessment(input: {
  channel: ImOutboundChannel
  purpose: ImOutboundFacts['purpose']
  body: string
  sessionId: string
  identityKey: string
  ownerId: string
  recipient: string
  classification: ImOutboundContentClass
  classifierVersion: string
  chatType?: ImOutboundFacts['chatType']
  destinationId?: string
}): ImOutboundFacts {
  return {
    channel: input.channel, purpose: input.purpose, originSessionId: input.sessionId, activeSessionId: input.sessionId,
    identityKey: input.identityKey, ownerId: input.ownerId, trustedRecipient: input.recipient, recipient: input.recipient,
    chatType: input.chatType ?? 'p2p', content: input.body,
    ...(input.destinationId ? { destinationId: input.destinationId } : {}),
    contentAssessment: { source: 'host', content: input.body, classification: input.classification, classifierVersion: input.classifierVersion },
    contentCompleteness: 'complete', hasAttachment: false, attachmentAuthorized: false
  }
}

export type ImOutboundClassification =
  | { kind: 'controlled-reply'; channel: ImOutboundChannel; recipient: string; sessionId: string }
  | { kind: 'active-outbound'; reason: string; channel: ImOutboundChannel }

export function classifyImOutbound(facts: ImOutboundFacts): ImOutboundClassification {
  const fail = (reason: string): ImOutboundClassification => ({ kind: 'active-outbound', reason, channel: facts.channel })
  if (facts.modelRecipient !== undefined) return fail('untrusted-recipient')
  if (facts.purpose !== 'task-reply') return fail('active-send')
  if (!facts.originSessionId || facts.originSessionId !== facts.activeSessionId) return fail('session-mismatch')
  if (!facts.identityKey || !facts.ownerId || !facts.trustedRecipient || facts.identityKey !== facts.trustedRecipient) return fail('owner-mismatch')
  if (facts.chatType !== 'p2p') return fail(facts.chatType === 'group' ? 'group-destination' : 'unknown-destination')
  if (facts.recipient && facts.recipient !== facts.trustedRecipient) return fail('third-party-recipient')
  if (facts.contentCompleteness !== 'complete' || !facts.contentAssessment ||
    facts.contentAssessment.source !== 'host' || !facts.contentAssessment.classifierVersion ||
    facts.contentAssessment.content !== facts.content) return fail('unknown-content')
  if (facts.contentAssessment.classification !== 'ordinary') return fail(facts.contentAssessment.classification)
  if (facts.hasAttachment && (!facts.attachmentAuthorized || !facts.attachmentContentVersion || facts.attachmentContentVersion !== facts.checkedAttachmentContentVersion || !facts.attachmentPath || facts.attachmentPath !== facts.checkedAttachmentPath)) {
    return fail('unverified-attachment')
  }
  return { kind: 'controlled-reply', channel: facts.channel, recipient: facts.trustedRecipient, sessionId: facts.originSessionId }
}


/** Fail closed immediately before a platform send unless all bound facts match. */
export function assertImOutboundAllowed(facts: ImOutboundFacts, actual: { channel: ImOutboundChannel; body: string; sessionId: string; recipient: string; destinationId?: string }): void {
  const matchesApprovedObject = facts.channel === actual.channel && facts.content === actual.body &&
    facts.destinationId === actual.destinationId && facts.activeSessionId === actual.sessionId &&
    facts.originSessionId === actual.sessionId && (facts.recipient ?? facts.trustedRecipient) === actual.recipient &&
    (facts.purpose === 'active-send' || !facts.trustedRecipient || facts.recipient === facts.trustedRecipient)
  if (!matchesApprovedObject) throw new Error('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
}
