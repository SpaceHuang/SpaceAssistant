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
  /** Host-prepared, exact ordinary-text attachment candidate outside workDir; promoted only after Agent approval. */
  externalAttachmentReview?: Readonly<{ path: string; sha256: string; answerer: 'agent' }>
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

/** Fail closed immediately before a platform send unless all bound facts match. */
export function assertImOutboundAllowed(facts: ImOutboundFacts, actual: { channel: ImOutboundChannel; body: string; sessionId: string; recipient: string; destinationId?: string }): void {
  const matchesApprovedObject = facts.channel === actual.channel && facts.content === actual.body &&
    facts.destinationId === actual.destinationId && facts.activeSessionId === actual.sessionId &&
    facts.originSessionId === actual.sessionId && (facts.recipient ?? facts.trustedRecipient) === actual.recipient &&
    (facts.purpose === 'active-send' || !facts.trustedRecipient || facts.recipient === facts.trustedRecipient)
  if (!matchesApprovedObject) throw new Error('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
}
