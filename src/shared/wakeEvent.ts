import { randomUUID } from 'crypto'

declare const wakeEventIdBrand: unique symbol
declare const wakeEventReasonKeyBrand: unique symbol
declare const wakeEventSessionIdBrand: unique symbol

export type WakeEventId = string & { readonly [wakeEventIdBrand]: true }
export type WakeEventReasonKey = string & { readonly [wakeEventReasonKeyBrand]: true }
export type WakeEventSessionId = string & { readonly [wakeEventSessionIdBrand]: true }

export type WakeEventType = 'im-inbound' | 'safety-recovery' | 'continuation'
export type WakeEventStatus = 'pending' | 'claimed' | 'acked'

export type WakeEventPayloadRef =
  | { readonly kind: 'im-inbox-message'; readonly messageId: string }
  | { readonly kind: 'safety-approval'; readonly approvalId: string }
  | { readonly kind: 'continuation'; readonly continuationId: string }

export interface WakeEvent {
  readonly eventId: WakeEventId
  readonly reasonKey: WakeEventReasonKey
  readonly sessionId: WakeEventSessionId
  readonly type: WakeEventType
  readonly payloadRef: WakeEventPayloadRef
  readonly status: WakeEventStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export type WakeEventInput =
  | { readonly type: 'im-inbound'; readonly sessionId: string; readonly reasonKey: string; readonly payloadRef: Extract<WakeEventPayloadRef, { kind: 'im-inbox-message' }> }
  | { readonly type: 'safety-recovery'; readonly sessionId: string; readonly reasonKey: string; readonly payloadRef: Extract<WakeEventPayloadRef, { kind: 'safety-approval' }> }
  | { readonly type: 'continuation'; readonly sessionId: string; readonly reasonKey: string; readonly payloadRef: Extract<WakeEventPayloadRef, { kind: 'continuation' }> }

export function createWakeEvent(input: WakeEventInput, now = Date.now(), eventId = randomUUID()): WakeEvent {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('Wake event timestamp must be a non-negative finite number')
  if (!input || (input.type !== 'im-inbound' && input.type !== 'safety-recovery' && input.type !== 'continuation')) {
    throw new TypeError('Unsupported wake event type')
  }
  const sessionId = input.sessionId.trim()
  const reasonKey = input.reasonKey.trim()
  if (!sessionId) throw new TypeError('Wake event sessionId must not be empty')
  if (!reasonKey) throw new TypeError('Wake event reasonKey must not be empty')
  if (!eventId.trim()) throw new TypeError('Wake event eventId must not be empty')
  const expectedPayloadKind = input.type === 'im-inbound'
    ? 'im-inbox-message'
    : input.type === 'safety-recovery' ? 'safety-approval' : 'continuation'
  if (!input.payloadRef || input.payloadRef.kind !== expectedPayloadKind) {
    throw new TypeError('Wake event payload reference does not match its event type')
  }
  const payloadId = expectedPayloadKind === 'im-inbox-message'
    ? (input.payloadRef as Extract<WakeEventPayloadRef, { kind: 'im-inbox-message' }>).messageId
    : expectedPayloadKind === 'safety-approval'
      ? (input.payloadRef as Extract<WakeEventPayloadRef, { kind: 'safety-approval' }>).approvalId
      : (input.payloadRef as Extract<WakeEventPayloadRef, { kind: 'continuation' }>).continuationId
  if (typeof payloadId !== 'string' || !payloadId.trim()) throw new TypeError('Wake event payload reference must not be empty')
  const payloadRef: WakeEventPayloadRef = expectedPayloadKind === 'im-inbox-message'
    ? { kind: 'im-inbox-message', messageId: payloadId }
    : expectedPayloadKind === 'safety-approval'
      ? { kind: 'safety-approval', approvalId: payloadId }
      : { kind: 'continuation', continuationId: payloadId }
  return {
    eventId: eventId as WakeEventId,
    reasonKey: reasonKey as WakeEventReasonKey,
    sessionId: sessionId as WakeEventSessionId,
    type: input.type,
    payloadRef,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  }
}
