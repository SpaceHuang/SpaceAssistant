import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import type { RuntimeTriggerAuthorizationBinding } from './delivery'
import { createRuntimeTriggerExecutionMaterials } from './runtimeMaterials'

const binding: RuntimeTriggerAuthorizationBinding = { bindingVersion: 1, requestId: 'runtime-trigger:trigger-1', ownerSessionId: 'owner',
  receiverSessionId: 'receiver', queueScope: { kind: 'desktop' }, sourceIdentity: { type: 'time' }, payloadDigest: 'payload-1',
  policyRevision: 'policy-1', authorizationGeneration: 'auth-1', runtimeGeneration: 'runtime-1' }
const trigger = { id: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'once',
  definition: { version: 1, condition: { type: 'time', at: '2030-01-01T00:00:00Z', taskPrompt: 'wake' }, sourceBaseline: {} },
  state: 'matched', createdAt: 1, expiresAt: 9_999_999_999_999, attempts: 0, revision: 2, updatedAt: 1, matchedAt: 2,
  event: { type: 'time', occurredAt: 1, taskPrompt: 'wake' }, result: { authorization: binding } } as unknown as RuntimeTriggerRecord

describe('runtime trigger execution materials', () => {
  it('only exposes matched, receiver-bound facts with the exact current authorization binding', () => {
    const read = vi.fn(() => trigger)
    let current = true
    const materials = createRuntimeTriggerExecutionMaterials({ read, isCurrentAuthorization: () => current })
    expect(materials.sourceContext({ sessionId: 'receiver', turnId: 'turn-1', requestId: binding.requestId })).toEqual({ triggerId: 'trigger-1', event: trigger.event })
    const admission = materials.admission({ sessionId: 'receiver', turnId: 'turn-1', requestId: binding.requestId })!
    expect(admission).toMatchObject({ triggerId: 'trigger-1', requestId: binding.requestId, turnId: 'turn-1', invocationId: 'turn-1' })
    const conn = { prepare: () => ({ get: () => ({ state: 'matched', owner_session_id: 'owner', receiver_session_id: 'receiver', result_json: JSON.stringify(trigger.result) }) }) }
    expect(admission.finalCheck(conn as never)).toBe(true)
    current = false
    expect(materials.sourceContext({ sessionId: 'receiver', turnId: 'turn-1', requestId: binding.requestId })).toBeUndefined()
    expect(admission.finalCheck(conn as never)).toBe(false)
    expect(materials.sourceContext({ sessionId: 'owner', turnId: 'turn-1', requestId: binding.requestId })).toBeUndefined()
  })

  it('verifies previously admitted history without reauthorizing a revoked source', () => {
    const persisted = { version: 1, triggerId: trigger.id, requestId: binding.requestId, receiverSessionId: 'receiver',
      turnId: 'turn-1', invocationId: 'turn-1', contextEventId: 'context-1', payloadDigest: binding.payloadDigest,
      policyRevision: binding.policyRevision, authorizationGeneration: binding.authorizationGeneration, runtimeGeneration: binding.runtimeGeneration }
    const admitted = { ...trigger, result: { authorization: binding, admission: persisted } } as unknown as RuntimeTriggerRecord
    const isCurrentAuthorization = vi.fn(() => false)
    const materials = createRuntimeTriggerExecutionMaterials({ read: () => admitted, isCurrentAuthorization,
      verifyPersistedAdmission: () => true })
    const request = { sessionId: 'receiver', turnId: 'turn-1', requestId: binding.requestId }
    expect(materials.verifyAdmission(request)).toBe(true)
    expect(isCurrentAuthorization).not.toHaveBeenCalled()
    expect(materials.sourceContext(request)).toBeUndefined()
    expect(isCurrentAuthorization).toHaveBeenCalledOnce()
  })
})
