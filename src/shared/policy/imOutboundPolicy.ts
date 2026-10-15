import type { ImOutboundFacts } from '../confirmation/outboundClassification'

export type ImOutboundPolicyDecision =
  | { type: 'allow'; ruleId: 'im-system-reply-ordinary' }
  | { type: 'deny'; ruleId: 'im-system-reply-review-required' }
  | { type: 'not-applicable' }

/** Policy for host-generated IM lifecycle/system replies; model tool calls use the normal policy gate. */
export function decideSystemImOutbound(facts: ImOutboundFacts): ImOutboundPolicyDecision {
  if (facts.purpose !== 'system-reply') return { type: 'not-applicable' }
  const recipient = facts.recipient
  const safeOwnerReply = !facts.modelRecipient && Boolean(facts.originSessionId) &&
    facts.originSessionId === facts.activeSessionId && facts.identityKey && facts.ownerId &&
    (recipient === facts.ownerId || recipient === facts.identityKey) && facts.trustedRecipient === recipient &&
    facts.chatType === 'p2p' && facts.contentCompleteness === 'complete' && !facts.hasAttachment &&
    facts.contentAssessment?.source === 'host' && facts.contentAssessment.content === facts.content &&
    facts.contentAssessment.classification === 'ordinary'
  return safeOwnerReply
    ? { type: 'allow', ruleId: 'im-system-reply-ordinary' }
    : { type: 'deny', ruleId: 'im-system-reply-review-required' }
}

export function assertSystemImOutboundPolicy(facts: ImOutboundFacts): void {
  const decision = decideSystemImOutbound(facts)
  if (decision.type === 'deny') throw new Error('IM_OUTBOUND_POLICY_REVIEW_REQUIRED')
}
