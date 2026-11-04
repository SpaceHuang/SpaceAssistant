import { describe, expect, it } from 'vitest'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import { createRuntimeTriggerAuthorizationBinding, runtimeTriggerAuthorizationMatches } from './hostAuthorization'

const trigger = { id: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'once',
  definition: { version: 1, condition: { type: 'time', at: '2030-01-01T00:00:00Z', taskPrompt: 'wake' }, sourceBaseline: {} },
  state: 'matched', createdAt: 1, expiresAt: 1000, attempts: 0, revision: 2, updatedAt: 1, matchedAt: 2, event: { type: 'time', occurredAt: 1 } } as unknown as RuntimeTriggerRecord
const scope = { kind: 'desktop' as const }
const authority = { policyRevision: 'desktop-v1:4', authorizationGeneration: 'local:2', runtimeGeneration: 'process:8' }

describe('runtime trigger host authorization binding', () => {
  it('binds the exact source payload, receiver scope and current authority revisions', () => {
    const binding = createRuntimeTriggerAuthorizationBinding({ trigger, queueScope: scope, authority, isAuthorized: () => true })!
    expect(binding).toMatchObject({ bindingVersion: 1, requestId: 'runtime-trigger:trigger-1', ownerSessionId: 'owner',
      receiverSessionId: 'receiver', sourceIdentity: trigger.definition.condition, policyRevision: authority.policyRevision,
      authorizationGeneration: authority.authorizationGeneration, runtimeGeneration: authority.runtimeGeneration })
    expect(binding.payloadDigest).toHaveLength(64)
    expect(runtimeTriggerAuthorizationMatches(trigger, scope, authority, binding)).toBe(true)
    expect(runtimeTriggerAuthorizationMatches({ ...trigger, event: { ...trigger.event, occurredAt: 2 } }, scope, authority, binding)).toBe(false)
    expect(runtimeTriggerAuthorizationMatches(trigger, scope, { ...authority, policyRevision: 'desktop-v1:5' }, binding)).toBe(false)
    expect(createRuntimeTriggerAuthorizationBinding({ trigger, queueScope: scope, authority, isAuthorized: () => false })).toBeNull()
  })
})
