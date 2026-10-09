import type { ApprovalInvocationResult } from '../../src/shared/confirmation/types'
import {
  mapDeferredApprovalResult,
  type DeferredApprovalEligibility,
  type DeferredApprovalResult
} from '../../src/shared/confirmation/deferredApprovalResult'
import { resolveImAsyncApprovalDisposition, type ImAsyncApprovalPolicyInput } from './imAsyncApprovalPolicy'
import type { DeferredCallEnvelopeInput } from './deferredEnvelopeStore'

type DeferredAdmission = {
  defer(input: { reservation: Record<string, unknown> & { reservationId: string; invocationId: string }; todo: unknown; ttlMs: number }): Promise<unknown>
}

type DeferredIntentStore = {
  prepare(input: { invocationId: string; sessionId: string; workflowId: string; taskId: string; stepId: string; planRevision: number; envelopeInvocationId: string }): unknown
  linkTodo(invocationId: string, todoId: string): unknown
  commitCheckpoint(invocationId: string, checkpoint: { checkpointId: string; workflowRevision: number }): unknown
  authorizeResume(invocationId: string): boolean
}

/** Internal gate adapter. It records an eligible approval as a todo, but never dispatches the action. */
export function createDeferredApprovalAdapter(input: {
  admission: DeferredAdmission
  /** Kept explicit so tests can prove this adapter never executes actions. */
  dispatch: (...args: never[]) => unknown
  fallback?: () => Promise<unknown>
  /** Durable intent gate. When supplied, deferred cannot escape before todo/checkpoint binding commits. */
  intentStore?: DeferredIntentStore
  envelopeStore?: { put(input: DeferredCallEnvelopeInput): unknown }
  commitTaskCheckpoint?(todo: Record<string, unknown>, todoId: string): { checkpointId: string; workflowRevision: number } | null | Promise<{ checkpointId: string; workflowRevision: number } | null>
  invalidateTodo?(todoId: string): void | Promise<void>
}) {
  return {
    async resolve(request: {
      approval: ApprovalInvocationResult
      eligibility: DeferredApprovalEligibility
      todo: Record<string, unknown>
      ttlMs: number
      policy?: Omit<ImAsyncApprovalPolicyInput, 'approval' | 'ttlMs'>
      checkpoint?: { checkpointId: string; workflowRevision: number }
      envelope?: DeferredCallEnvelopeInput
    }): Promise<DeferredApprovalResult | unknown> {
      const disposition = request.policy
        ? resolveImAsyncApprovalDisposition({ ...request.policy, approval: request.approval, ttlMs: request.ttlMs })
        : undefined
      if (disposition?.kind === 'user-fallback') return input.fallback ? input.fallback() : disposition
      if (disposition?.kind === 'deny') return { kind: 'deny', cause: disposition.cause }
      if (disposition?.kind === 'agent-approved') {
        return request.approval.ok && request.approval.verdict.kind === 'approve'
          ? { kind: 'approve', verdict: request.approval.verdict }
          : { kind: 'deny', cause: 'config-error' }
      }
      const mapped: DeferredApprovalResult = disposition?.kind === 'deferred'
        ? { kind: 'deferred', todoId: typeof request.todo.todoId === 'string' ? request.todo.todoId : '', cause: disposition.cause }
        : mapDeferredApprovalResult(request.approval, request.eligibility)
      if (mapped.kind !== 'deferred') return mapped
      let admittedTodoId: string | undefined
      const invocationId = typeof request.todo.invocationId === 'string' ? request.todo.invocationId : ''
      const reservationId = typeof request.todo.reservationId === 'string' ? request.todo.reservationId : ''
      const originSessionId = typeof request.todo.originSessionId === 'string' ? request.todo.originSessionId : ''
      const identityKey = typeof request.todo.identityKey === 'string' ? request.todo.identityKey : ''
      const createdAt = typeof request.todo.createdAt === 'number' ? request.todo.createdAt : Date.now()
      const expiresAt = typeof request.todo.expiresAt === 'number' ? request.todo.expiresAt : createdAt + request.ttlMs
      const channel = typeof request.todo.channel === 'string' ? request.todo.channel : ''
      const ownerId = typeof request.todo.ownerId === 'string' ? request.todo.ownerId : ''
      if (!invocationId || !reservationId || !originSessionId || !identityKey || !channel || !ownerId || request.todo.todoId !== mapped.todoId) {
        return input.fallback ? input.fallback() : { kind: 'rejected', cause: 'unavailable' }
      }
      try {
        const intentBinding = request.todo as Record<string, unknown>
        if (input.envelopeStore) {
          if (!request.envelope || request.envelope.invocationId !== invocationId ||
            !request.envelope.requestId?.trim() || !request.envelope.turnId?.trim() || !request.envelope.toolCallId?.trim() ||
            request.envelope.toolName.trim() === '') {
            throw new Error('DEFERRED_ENVELOPE_MATERIAL_REQUIRED')
          }
        }
        const admitted = await input.admission.defer({
          reservation: {
            reservationId, invocationId, sessionId: originSessionId, identityKey, channel, ownerId,
            state: 'prepared', now: createdAt, expiresAt
          },
          todo: request.todo,
          ttlMs: request.ttlMs
        })
        if (!admitted || typeof admitted !== 'object' || (admitted as { kind?: unknown }).kind !== 'deferred') {
          return admitted ?? (input.fallback ? await input.fallback() : { kind: 'rejected', cause: 'unavailable' })
        }
        admittedTodoId = mapped.todoId
        if (input.intentStore) {
          const workflowId = typeof intentBinding.workflowId === 'string' ? intentBinding.workflowId : ''
          const taskId = typeof intentBinding.taskId === 'string' ? intentBinding.taskId : ''
          const stepId = typeof intentBinding.stepId === 'string' ? intentBinding.stepId : ''
          const planRevision = intentBinding.planRevision
          if (!workflowId || !taskId || !stepId || !Number.isInteger(planRevision) || (planRevision as number) <= 0 ||
            (!input.commitTaskCheckpoint && (!request.checkpoint || !request.checkpoint.checkpointId.trim() ||
              !Number.isInteger(request.checkpoint.workflowRevision) || request.checkpoint.workflowRevision <= 0))) {
            return input.fallback ? await input.fallback() : { kind: 'rejected', cause: 'unavailable' }
          }
          input.intentStore.prepare({ invocationId, sessionId: originSessionId, workflowId, taskId, stepId,
            planRevision: planRevision as number, envelopeInvocationId: invocationId })
        }
        if (input.envelopeStore) {
          input.envelopeStore.put(request.envelope!)
        }
        if (input.intentStore) {
          input.intentStore.linkTodo(invocationId, mapped.todoId)
          const checkpoint = input.commitTaskCheckpoint
            ? await input.commitTaskCheckpoint(request.todo, mapped.todoId)
            : request.checkpoint
          if (!checkpoint) throw new Error('DEFERRED_TASK_CHECKPOINT_NOT_COMMITTED')
          input.intentStore.commitCheckpoint(invocationId, checkpoint)
          if (!input.intentStore.authorizeResume(invocationId)) throw new Error('SECURITY_ACTION_CHECKPOINT_NOT_COMMITTED')
        }
        return mapped
      } catch {
        if (admittedTodoId) {
          try { await input.invalidateTodo?.(admittedTodoId) } catch { /* invalidation remains fail-closed without intent authorization */ }
        }
        return input.fallback ? input.fallback() : { kind: 'rejected', cause: 'unavailable' }
      }
    }
  }
}
