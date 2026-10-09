/** Non-empty value validated at the queue-scope boundary. */
declare const nonEmptyQueueScopeFieldBrand: unique symbol
export type NonEmptyQueueScopeField = string & { readonly [nonEmptyQueueScopeFieldBrand]: true }

export type QueueScopeChannel = 'feishu' | 'wechat'

export type QueueScope =
  | { readonly kind: 'desktop' }
  | {
      readonly kind: 'im'
      readonly channel: QueueScopeChannel
      readonly sessionId: NonEmptyQueueScopeField
    }

export function buildImQueueScope(channel: QueueScopeChannel, sessionId: string): Extract<QueueScope, { kind: 'im' }> {
  if (channel !== 'feishu' && channel !== 'wechat') {
    throw new TypeError('Unsupported IM queue channel')
  }
  if (sessionId.trim().length === 0) {
    throw new TypeError('IM queue sessionId must not be empty')
  }
  return { kind: 'im', channel, sessionId: sessionId as NonEmptyQueueScopeField }
}

export function serializeQueueScope(scope: QueueScope): string {
  if (scope.kind === 'desktop') return 'desktop'
  if (scope.kind !== 'im' || (scope.channel !== 'feishu' && scope.channel !== 'wechat')) {
    throw new TypeError('Invalid queue scope')
  }
  if (scope.sessionId.trim().length === 0) {
    throw new TypeError('IM queue sessionId must not be empty')
  }
  return `im:${scope.channel}:${encodeURIComponent(scope.sessionId)}`
}

export function parseQueueScope(serialized: string): QueueScope {
  if (serialized === 'desktop') return { kind: 'desktop' }
  if (!serialized.startsWith('im:')) throw new TypeError('Invalid queue scope serialization')

  const channelEnd = serialized.indexOf(':', 3)
  if (channelEnd < 0) throw new TypeError('Invalid queue scope serialization')
  const channel = serialized.slice(3, channelEnd)
  const encodedSessionId = serialized.slice(channelEnd + 1)
  if (channel !== 'feishu' && channel !== 'wechat') throw new TypeError('Unsupported IM queue channel')
  if (encodedSessionId.length === 0) throw new TypeError('IM queue sessionId must not be empty')

  let sessionId: string
  try {
    sessionId = decodeURIComponent(encodedSessionId)
  } catch {
    throw new TypeError('Invalid encoded IM queue sessionId')
  }
  const scope = buildImQueueScope(channel, sessionId)
  if (encodeURIComponent(sessionId) !== encodedSessionId) throw new TypeError('Non-canonical IM queue sessionId')
  return scope
}
