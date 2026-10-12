export type PromptSendErrorCategory =
  | 'bot-unavailable'
  | 'inbound-context-missing'
  | 'credentials-unavailable'
  | 'api-rejected'
  | 'transport-failed'
  | 'message-binding-unavailable'
  | 'unknown'

export type PromptSendNotAttemptedErrorCategory = PromptSendErrorCategory

export type PromptSendResult =
  | { kind: 'sent'; sendCall: 'fulfilled'; delivery: 'bound'; binding: { kind: 'message-id'; value: string; clientId?: string } | { kind: 'quoted-content-token'; marker: string } }
  | { kind: 'not-attempted'; sendCall: 'not-attempted'; delivery: 'not-attempted'; errorCategory: PromptSendNotAttemptedErrorCategory }
  | { kind: 'send-rejected'; sendCall: 'rejected'; delivery: 'unknown'; error: unknown }
  | { kind: 'binding-unavailable'; sendCall: 'fulfilled'; delivery: 'unbound'; errorCategory: 'message-binding-unavailable' }
  | { kind: 'timed-out'; sendCall: 'pending'; delivery: 'unknown' }
  | { kind: 'cancelled'; sendCall: 'pending' | 'fulfilled'; delivery: 'unbound' }
