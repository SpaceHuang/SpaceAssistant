import { createHash } from 'node:crypto'
import type { QueueScope } from '../../src/shared/queueScope'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import type { RuntimeTriggerAuthorizationBinding } from './delivery'

export type RuntimeTriggerAuthoritySnapshot = Readonly<{
  policyRevision: string
  authorizationGeneration: string
  runtimeGeneration: string
}>

/** Policy phase calls the current host source-authorization predicate; this function only binds its result. */
export function createRuntimeTriggerAuthorizationBinding(input: {
  trigger: RuntimeTriggerRecord
  queueScope: QueueScope
  authority: RuntimeTriggerAuthoritySnapshot
  isAuthorized: () => boolean
  sourceDecisionTrace?: Readonly<Record<string, unknown>>
}): RuntimeTriggerAuthorizationBinding | null {
  const { trigger, queueScope, authority } = input
  if (trigger.state !== 'matched' || !trigger.event || !authority.policyRevision.trim() ||
    !authority.authorizationGeneration.trim() || !authority.runtimeGeneration.trim() || !input.isAuthorized()) return null
  return {
    bindingVersion: 1,
    requestId: `runtime-trigger:${trigger.id}`,
    ownerSessionId: trigger.ownerSessionId,
    receiverSessionId: trigger.receiverSessionId,
    queueScope,
    sourceIdentity: structuredClone(trigger.definition.condition) as Readonly<Record<string, unknown>>,
    payloadDigest: createHash('sha256').update(JSON.stringify(trigger.event)).digest('hex'),
    policyRevision: authority.policyRevision,
    authorizationGeneration: authority.authorizationGeneration,
    runtimeGeneration: authority.runtimeGeneration,
    ...(input.sourceDecisionTrace ? { sourceDecisionTrace: structuredClone(input.sourceDecisionTrace) } : {})
  }
}

export function runtimeTriggerAuthorizationMatches(trigger: RuntimeTriggerRecord, queueScope: QueueScope,
  authority: RuntimeTriggerAuthoritySnapshot, approved: RuntimeTriggerAuthorizationBinding,
  sourceDecisionTrace?: Readonly<Record<string, unknown>>): boolean {
  if (approved.requestId !== `runtime-trigger:${trigger.id}` || approved.ownerSessionId !== trigger.ownerSessionId ||
    approved.receiverSessionId !== trigger.receiverSessionId || JSON.stringify(approved.queueScope) !== JSON.stringify(queueScope) ||
    JSON.stringify(approved.sourceIdentity) !== JSON.stringify(trigger.definition.condition) || !trigger.event) return false
  const current = createRuntimeTriggerAuthorizationBinding({ trigger, queueScope, authority, isAuthorized: () => true,
    ...(sourceDecisionTrace ? { sourceDecisionTrace } : {}) })
  return Boolean(current && JSON.stringify(current) === JSON.stringify(approved))
}
