type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value

import type {
  RemoteArtifactDecisionAuditEvent,
  RemoteContext
} from '../../electron/tools/types'

type SendDecisionText = NonNullable<RemoteContext['sendDecisionText']>
type SendParams = Parameters<SendDecisionText>

type SendTextOnly = Expect<Equal<SendParams, [text: string]>>
type SendArity = Expect<Equal<SendParams['length'], 1>>

type AllowedAuditEvents =
  | 'prompt'
  | 'prompt_failed'
  | 'resolved'
  | 'hint'
  | 'stale'
  | 'binding_mismatch'
  | 'invalid'
  | 'ambiguous'
  | 'unknown_id'
  | 'authorization_revoked'

type AuditEventGuard = Expect<Equal<RemoteArtifactDecisionAuditEvent, AllowedAuditEvents>>

export type RemoteDecisionOutboundTypecheck = SendTextOnly & SendArity & AuditEventGuard

declare const send: SendDecisionText
void send('hello')

declare const append: NonNullable<RemoteContext['appendArtifactDecisionAudit']>
void append('prompt', { decisionId: 'd1' })

// @ts-expect-error sendDecisionText must not accept a target argument
void send('hello', { chatId: 'c1' })

// @ts-expect-error audit event must be from the design enum
void append('raw_reply', {})
