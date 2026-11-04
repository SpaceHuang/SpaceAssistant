import type { QueueScope } from '../../src/shared/queueScope'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'
import type { RuntimeTriggerAuthorizationBinding } from './delivery'

type TriggerTurn = Readonly<{ requestId: string; sessionId: string; turnId: string; invocationId?: string }>

/**
 * Shared start gate: facts are the trigger/receipt/marker identities below; `reauthorize` is the policy
 * entry and must persist the existing stable decision trace. Freshness comparison is final-check only;
 * first source-bearing context is checked again by SqliteAgentHistory on the committing connection.
 */
export function createRuntimeTriggerStartAuthorizer(input: {
  read(triggerId: string): RuntimeTriggerRecord | null
  update(triggerId: string, expectedRevision: number, patch: { result: Readonly<Record<string, unknown>>; updatedAt: number }): RuntimeTriggerRecord | null
  resolveQueueScope(turn: TriggerTurn): QueueScope | undefined
  readReceipt(input: { sessionId: string; requestId: string; queueScope: QueueScope }): { queuedMessageId?: string; turnId?: string; state: string } | undefined
  classify(input: { sessionId: string; requestId: string; queueScope: QueueScope; queuedMessageId: string }): 'runtime-trigger' | 'invalid' | string
  verifyAdmission(trigger: RuntimeTriggerRecord, turn: TriggerTurn): boolean
  readCurrentAuthorization(trigger: RuntimeTriggerRecord): Readonly<{ policyRevision: string; authorizationGeneration: string; runtimeGeneration: string }> | undefined
  /** Re-enters the existing policy path and writes its stable decision trace when versions changed. */
  reauthorize(trigger: RuntimeTriggerRecord, queueScope: QueueScope): RuntimeTriggerAuthorizationBinding | null
  cancel(input: { sessionId: string; requestId: string; queueScope: QueueScope; turnId: string }): void
  fail(trigger: RuntimeTriggerRecord, caseId: 'authorization-revoked' | 'authorization-binding-invalid' | 'start-receipt-invalid'): void
  now?: () => number
}) {
  const now = input.now ?? Date.now
  return (turn: TriggerTurn): boolean => {
    if (!turn.requestId.startsWith('runtime-trigger:')) return true
    const triggerId = turn.requestId.slice('runtime-trigger:'.length)
    const trigger = input.read(triggerId)
    const scope = input.resolveQueueScope(turn)
    const receipt = scope && input.readReceipt({ sessionId: turn.sessionId, requestId: turn.requestId, queueScope: scope })
    const reject = (caseId: 'authorization-revoked' | 'authorization-binding-invalid' | 'start-receipt-invalid' = 'start-receipt-invalid') => {
      if (scope) input.cancel({ sessionId: turn.sessionId, requestId: turn.requestId, queueScope: scope, turnId: turn.turnId })
      if (trigger?.state === 'matched') input.fail(trigger, caseId)
      return false
    }
    if (!trigger || trigger.id !== triggerId || trigger.state !== 'matched' || trigger.receiverSessionId !== turn.sessionId ||
      !scope || !receipt?.queuedMessageId || receipt.turnId !== turn.turnId || receipt.state !== 'claimed' ||
      input.classify({ sessionId: turn.sessionId, requestId: turn.requestId, queueScope: scope, queuedMessageId: receipt.queuedMessageId }) !== 'runtime-trigger') return reject()
    const binding = trigger.result?.authorization as RuntimeTriggerAuthorizationBinding | undefined
    if (!binding || binding.bindingVersion !== 1 || binding.requestId !== turn.requestId || binding.ownerSessionId !== trigger.ownerSessionId ||
      binding.receiverSessionId !== turn.sessionId || JSON.stringify(binding.queueScope) !== JSON.stringify(scope)) return reject('authorization-binding-invalid')
    // A verified prior first-context commit is ordinary accepted history: source revocation is non-retroactive.
    if (trigger.result?.admission !== undefined) return input.verifyAdmission(trigger, turn) || reject('authorization-binding-invalid')
    const current = input.readCurrentAuthorization(trigger)
    if (current && current.policyRevision === binding.policyRevision && current.authorizationGeneration === binding.authorizationGeneration &&
      current.runtimeGeneration === binding.runtimeGeneration) return true
    const refreshed = input.reauthorize(trigger, scope)
    if (!refreshed || refreshed.bindingVersion !== 1 || refreshed.requestId !== turn.requestId || refreshed.ownerSessionId !== trigger.ownerSessionId ||
      refreshed.receiverSessionId !== turn.sessionId || JSON.stringify(refreshed.queueScope) !== JSON.stringify(scope)) return reject('authorization-revoked')
    const saved = input.update(trigger.id, trigger.revision, { result: { ...(trigger.result ?? {}), authorization: refreshed }, updatedAt: now() })
    if (!saved) return reject('authorization-binding-invalid')
    return true
  }
}
