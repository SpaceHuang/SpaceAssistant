import type { RuntimeTriggerHistoryAdmission, RuntimeTriggerRecord } from '../sessionStorage/public/model'
import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeTriggerAuthorizationBinding } from './delivery'

type RuntimeTriggerRequest = Readonly<{ sessionId: string; turnId: string; requestId: string }>

/** Bind persisted source facts and their approved material to one receiver invocation. */
export function createRuntimeTriggerExecutionMaterials(input: {
  read(triggerId: string): RuntimeTriggerRecord | null
  isCurrentAuthorization(trigger: RuntimeTriggerRecord, binding: RuntimeTriggerAuthorizationBinding): boolean
  verifyPersistedAdmission?(trigger: RuntimeTriggerRecord, admission: Readonly<Record<string, unknown>>): boolean
}) {
  const resolve = (request: RuntimeTriggerRequest): { trigger: RuntimeTriggerRecord; binding: RuntimeTriggerAuthorizationBinding } | undefined => {
    if (!request.requestId.startsWith('runtime-trigger:') || !request.sessionId.trim() || !request.turnId.trim()) return undefined
    const triggerId = request.requestId.slice('runtime-trigger:'.length)
    const trigger = input.read(triggerId)
    if (!trigger || trigger.id !== triggerId || trigger.state !== 'matched' || trigger.receiverSessionId !== request.sessionId || !trigger.event) return undefined
    const binding = trigger.result?.authorization as RuntimeTriggerAuthorizationBinding | undefined
    if (!binding || binding.bindingVersion !== 1 || binding.requestId !== request.requestId || binding.ownerSessionId !== trigger.ownerSessionId ||
      binding.receiverSessionId !== request.sessionId || !binding.payloadDigest || !binding.policyRevision || !binding.authorizationGeneration ||
      !binding.runtimeGeneration || !input.isCurrentAuthorization(trigger, binding)) return undefined
    return { trigger, binding }
  }
  return {
    verifyAdmission(request: RuntimeTriggerRequest): boolean {
      if (!request.requestId.startsWith('runtime-trigger:')) return false
      const trigger = input.read(request.requestId.slice('runtime-trigger:'.length))
      const admission = trigger?.result?.admission as Record<string, unknown> | undefined
      const binding = trigger?.result?.authorization as RuntimeTriggerAuthorizationBinding | undefined
      return Boolean(trigger && admission && binding && trigger.state === 'matched' && trigger.receiverSessionId === request.sessionId &&
        trigger.id === request.requestId.slice('runtime-trigger:'.length) && admission.version === 1 && admission.triggerId === trigger.id &&
        admission.requestId === request.requestId && admission.receiverSessionId === request.sessionId && admission.turnId === request.turnId &&
        admission.invocationId === request.turnId && typeof admission.contextEventId === 'string' && admission.contextEventId &&
        admission.payloadDigest === binding.payloadDigest && admission.policyRevision === binding.policyRevision &&
        admission.authorizationGeneration === binding.authorizationGeneration && admission.runtimeGeneration === binding.runtimeGeneration &&
        input.verifyPersistedAdmission?.(trigger, admission) === true)
    },
    sourceContext(request: RuntimeTriggerRequest): { triggerId: string; event: Readonly<Record<string, unknown>> } | undefined {
      const result = resolve(request)
      return result ? { triggerId: result.trigger.id, event: structuredClone(result.trigger.event!) } : undefined
    },
    admission(request: RuntimeTriggerRequest): RuntimeTriggerHistoryAdmission | undefined {
      const result = resolve(request)
      if (!result) return undefined
      const { trigger, binding } = result
      const admission = trigger.result?.admission as Record<string, unknown> | undefined
      if (admission && (admission.version !== 1 || admission.triggerId !== trigger.id || admission.requestId !== request.requestId ||
        admission.receiverSessionId !== request.sessionId || admission.turnId !== request.turnId || admission.invocationId !== request.turnId ||
        typeof admission.contextEventId !== 'string' || !admission.contextEventId)) return undefined
      const admissionTemplate: RuntimeTriggerHistoryAdmission = {
        triggerId: trigger.id, requestId: request.requestId, receiverSessionId: request.sessionId, turnId: request.turnId,
        invocationId: request.turnId, ...(admission ? { contextEventId: admission.contextEventId as string } : {}),
        payloadDigest: binding.payloadDigest, authorizationGeneration: binding.authorizationGeneration,
        policyRevision: binding.policyRevision, runtimeGeneration: binding.runtimeGeneration,
        finalCheck: (rawConn) => {
          try {
            const conn = rawConn as DatabaseSync
            const row = conn.prepare(`SELECT owner_session_id,receiver_session_id,state,result_json FROM runtime_triggers
              WHERE id=? AND receiver_session_id=?`).get(trigger.id, request.sessionId) as {
                owner_session_id: string; receiver_session_id: string; state: string; result_json: string | null
              } | undefined
            if (!row || row.owner_session_id !== trigger.ownerSessionId || row.receiver_session_id !== request.sessionId || row.state !== 'matched') return false
            const currentResult = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {}
            if (currentResult.admission !== undefined) return JSON.stringify(currentResult.admission) === JSON.stringify(admission)
            const currentBinding = currentResult.authorization as RuntimeTriggerAuthorizationBinding | undefined
            return JSON.stringify(currentBinding) === JSON.stringify(binding) && input.isCurrentAuthorization(trigger, binding)
          } catch { return false }
        }
      }
      return admissionTemplate
    }
  }
}
