import { describe, expectTypeOf, it } from 'vitest'
import type { WakeEvent, WakeEventPayloadRef, WakeEventReasonKey, WakeEventStatus, WakeEventType } from './wakeEvent'

describe('WakeEvent type contract', () => {
  it('requires stable identity, unique reason key, session ownership, controlled payload reference, status and timestamps', () => {
    expectTypeOf<WakeEvent['eventId']>().toMatchTypeOf<string>()
    expectTypeOf<WakeEvent['reasonKey']>().toEqualTypeOf<WakeEventReasonKey>()
    expectTypeOf<WakeEvent['sessionId']>().toMatchTypeOf<string>()
    expectTypeOf<WakeEvent['type']>().toEqualTypeOf<WakeEventType>()
    expectTypeOf<WakeEvent['payloadRef']>().toEqualTypeOf<WakeEventPayloadRef>()
    expectTypeOf<WakeEvent['status']>().toEqualTypeOf<WakeEventStatus>()
    expectTypeOf<WakeEvent['createdAt']>().toEqualTypeOf<number>()
    expectTypeOf<WakeEvent['updatedAt']>().toEqualTypeOf<number>()
  })

  it('limits event types to admitted runtime causes', () => {
    const inbound: WakeEventType = 'im-inbound'
    const recovery: WakeEventType = 'safety-recovery'
    const continuation: WakeEventType = 'continuation'
    // @ts-expect-error Model supplied scope or cursor must not become a wake event type.
    const modelChosen: WakeEventType = 'model-scope'
    expectTypeOf<typeof inbound>().toMatchTypeOf<WakeEventType>()
    expectTypeOf<typeof recovery>().toMatchTypeOf<WakeEventType>()
    expectTypeOf<typeof continuation>().toMatchTypeOf<WakeEventType>()
    expectTypeOf<typeof modelChosen>().toMatchTypeOf<WakeEventType>()
  })
})
