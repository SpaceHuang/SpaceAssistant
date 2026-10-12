import { parseClarificationReply } from './clarificationHandle'
import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'

export type ClarificationResolverResult =
  | { kind: 'resolved' | 'already-resolved'; trackId: string; workId: string; parentTrackId?: string }
  | { kind: 'unknown' | 'stale' | 'expired' | 'unauthorized' | 'not-sent' | 'invalid-option' | 'candidate-invalidated' }
export type ClarificationControlResultKind = ClarificationResolverResult['kind'] | 'invalid' | 'unavailable'

export type ClarificationResolverInput = {
  channel: RemoteTrackChannel
  identityKey: string
  ownerId: string
  replyMessageId: string
  handle: string
  option: number
}
export type ClarificationResolverContext = Omit<ClarificationResolverInput, 'handle' | 'option'> & {
  legacyBareOptionPending?: boolean
  resolve: (input: ClarificationResolverInput) => Promise<ClarificationResolverResult>
}

export async function resolveClarificationControlMessage(
  text: string,
  context?: ClarificationResolverContext
): Promise<{ consumed: false } | { consumed: true; resultKind: ClarificationControlResultKind; reply: string }> {
  const parsed = parseClarificationReply(text, { reserveLegacyOption: context?.legacyBareOptionPending })
  if (parsed.kind === 'ordinary') return { consumed: false }
  if (parsed.kind === 'control-like-invalid') {
    return { consumed: true, resultKind: 'invalid', reply: '澄清回复格式无效，请按「选择 <句柄> <选项>」回复最新提示。' }
  }
  if (!context) return { consumed: true, resultKind: 'unavailable', reply: '这条澄清当前无法关联，请重新描述原问题。' }

  const { resolve, ...scope } = context
  try {
    const result = await resolve({ ...scope, handle: parsed.handle, option: parsed.option })
    switch (result.kind) {
      case 'resolved': return { consumed: true, resultKind: result.kind, reply: '已收到选择，正在继续处理。' }
      case 'already-resolved': return { consumed: true, resultKind: result.kind, reply: '这条澄清已处理。' }
      case 'stale': return { consumed: true, resultKind: result.kind, reply: '这是旧版澄清选项，请按最新提示回复；若无提示请重述原问题。' }
      case 'expired': return { consumed: true, resultKind: result.kind, reply: '澄清已超时，请重新发送原问题。' }
      case 'not-sent': return { consumed: true, resultKind: result.kind, reply: '找不到已发出的澄清提示，请重新发送原问题。' }
      case 'invalid-option': return { consumed: true, resultKind: result.kind, reply: '选项无效，请按最新澄清提示选择。' }
      case 'candidate-invalidated': return { consumed: true, resultKind: result.kind, reply: '候选任务已失效，请重新描述原问题。' }
      case 'unauthorized': return { consumed: true, resultKind: result.kind, reply: '无法验证这条澄清的身份，请重新发送原问题。' }
      case 'unknown': return { consumed: true, resultKind: result.kind, reply: '找不到这条澄清，请重新描述原问题。' }
    }
  } catch {
    return { consumed: true, resultKind: 'unavailable', reply: '澄清处理暂时不可用，请重新描述原问题。' }
  }
}
