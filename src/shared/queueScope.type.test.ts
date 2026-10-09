import { describe, expectTypeOf, it } from 'vitest'
import type { NonEmptyQueueScopeField, QueueScope, QueueScopeChannel } from './queueScope'

describe('QueueScope type contract', () => {
  it('only exposes desktop and feishu/wechat IM scope variants', () => {
    expectTypeOf<QueueScope['kind']>().toEqualTypeOf<'desktop' | 'im'>()
    expectTypeOf<QueueScopeChannel>().toEqualTypeOf<'feishu' | 'wechat'>()
  })

  it('requires non-empty session and channel fields for IM scope', () => {
    type ImScope = Extract<QueueScope, { kind: 'im' }>
    expectTypeOf<ImScope['sessionId']>().toEqualTypeOf<NonEmptyQueueScopeField>()

    // @ts-expect-error IM session identifiers must be validated non-empty values.
    const emptySession: NonEmptyQueueScopeField = ''
    // @ts-expect-error Unsupported channel names are outside the queue scope contract.
    const unsupportedChannel: QueueScopeChannel = 'discord'
    expectTypeOf<typeof emptySession>().toEqualTypeOf<NonEmptyQueueScopeField>()
    expectTypeOf<typeof unsupportedChannel>().toEqualTypeOf<QueueScopeChannel>()
  })
})
