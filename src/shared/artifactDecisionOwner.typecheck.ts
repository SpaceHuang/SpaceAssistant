type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value

import type { RemoteArtifactDecisionOwner } from './artifactDecisionTypes'

type OwnerSource = RemoteArtifactDecisionOwner['source']
type SourceGuard = Expect<Equal<OwnerSource, 'feishu' | 'wechat'>>

type RequiredOwnerKeys =
  | 'source'
  | 'authOwner'
  | 'privateChatTarget'
  | 'originSessionId'
  | 'requestId'
  | 'decisionId'

type OwnerKeysGuard = Expect<Equal<keyof RemoteArtifactDecisionOwner, RequiredOwnerKeys>>

export type RemoteArtifactDecisionOwnerTypecheck = SourceGuard & OwnerKeysGuard

const _valid: RemoteArtifactDecisionOwner = {
  source: 'feishu',
  authOwner: 'user-1',
  privateChatTarget: 'chat-1',
  originSessionId: 'session-1',
  requestId: 'req-1',
  decisionId: 'decision-1'
}

void _valid

const _badSource: RemoteArtifactDecisionOwner = {
  // @ts-expect-error source must be feishu or wechat
  source: 'slack',
  authOwner: 'user-1',
  privateChatTarget: 'chat-1',
  originSessionId: 'session-1',
  requestId: 'req-1',
  decisionId: 'decision-1'
}

void _badSource
