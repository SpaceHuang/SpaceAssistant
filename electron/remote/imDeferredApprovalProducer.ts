import { createHash, randomUUID } from 'node:crypto'
import type { ConfirmOutcome, ApprovalInvocationResult } from '../../src/shared/confirmation/types'
import type { RemoteContext } from '../tools/types'
import type { AppDatabase } from '../database/sqliteStore'
import type { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import type { createDeferredTodoCapacityController } from '../confirmation/deferredTodoCapacity'
import type { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import type { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import type { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredTodoAdmission } from '../confirmation/deferredTodoAdmission'
import { createDeferredApprovalAdapter } from '../confirmation/deferredApprovalAdapter'
import { resolveImAsyncApprovalDisposition } from '../confirmation/imAsyncApprovalPolicy'
import { commitDeferredTaskCheckpoint } from '../database/taskControl'
import type { ConfirmationPort, ToolConfirmationResult } from '../../packages/agent-sdk/src/turn'
import type { GateConfirmationContext } from '../confirmation/agentSdkConfirmationPort'

function factsHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function approvalFromOutcome(outcome: ConfirmOutcome): ApprovalInvocationResult {
  const summary = 'reason' in outcome ? outcome.reason?.summary : undefined
  if (outcome.kind === 'approved' || outcome.kind === 'approved-with-action') {
    return { ok: true, verdict: { kind: 'approve', reason: { summary: summary ?? '' } } }
  }
  if (outcome.cause === 'agent-deny') return { ok: true, verdict: { kind: 'deny', reason: { summary: summary ?? '' } } }
  if (outcome.cause === 'agent-undetermined') return { ok: true, verdict: { kind: 'undetermined', reason: { summary: summary ?? '' } } }
  const cause = outcome.cause
  if (cause === 'config-error') return { ok: false, cause: 'config-error', summary }
  if (cause === 'timeout') return { ok: false, cause: 'timeout', summary }
  if (cause === 'unparsable') return { ok: false, cause: 'unparsable', summary }
  return { ok: false, cause: 'unavailable', summary }
}

/** Creates an IM-only deferred producer. IDs and task scope come from the authenticated runtime, never model arguments. */
export function createImDeferredApprovalProducer(input: {
  db: AppDatabase
  channel: 'feishu' | 'wechat'
  todoStore: ReturnType<typeof createDeferredTodoStore>
  capacity: ReturnType<typeof createDeferredTodoCapacityController>
  intentStore: ReturnType<typeof createSecurityActionIntentStore>
  envelopeStore: ReturnType<typeof createDeferredEnvelopeStore>
  notificationDelivery: ReturnType<typeof createDeferredApprovalNotificationDelivery>
  isEnabled(): boolean
  getAuthorizationEpoch(): number
  resolveTaskDigest(context: RemoteContext): string | undefined
  ttlMs?: number
}) {
  const admission = createDeferredTodoAdmission({
    capacity: input.capacity,
    todoStore: { create: (todo) => input.todoStore.create(todo as never) },
    dispatch: () => undefined,
    sendReceipt: () => undefined
  })
  const adapter = createDeferredApprovalAdapter({
    admission,
    dispatch: () => undefined,
    intentStore: input.intentStore,
    envelopeStore: input.envelopeStore,
    commitTaskCheckpoint: (todo, todoId) => {
      const binding = todo.taskBinding as RemoteContext['taskBinding']
      if (!binding) return null
      const result = commitDeferredTaskCheckpoint(input.db, {
        sessionId: String(todo.originSessionId), ownerId: String(todo.ownerId), workflowId: binding.workflowId,
        taskId: binding.taskId, planRevision: binding.planRevision, expectedRevision: binding.revision,
        invocationId: String(todo.invocationId), todoId, stepId: binding.stepId
      })
      return result.ok ? result.checkpoint : null
    },
    invalidateTodo: (todoId) => { input.todoStore.invalidate(todoId) }
  })

  return {
    async defer(
      call: Parameters<ConfirmationPort>[0]['call'],
      outcome: ToolConfirmationResult,
      confirmation: Parameters<ConfirmationPort>[0],
      context: GateConfirmationContext,
      primaryOutcome: ConfirmOutcome,
      remoteContext: RemoteContext
    ): Promise<Extract<ToolConfirmationResult, { kind: 'deferred' }> | undefined> {
      if ((outcome as { answerer?: unknown }).answerer !== 'agent' || !input.isEnabled() || remoteContext.source !== input.channel) return undefined
      const binding = remoteContext.taskBinding
      const identityKey = input.channel === 'feishu' ? remoteContext.chatId : remoteContext.userId
      const ownerId = remoteContext.authOwner
      const requestId = remoteContext.requestId
      const turnId = remoteContext.turnId
      const messageId = remoteContext.messageId
      const providerRouteId = remoteContext.providerRouteId
      const model = remoteContext.model
      const workDirProfileId = remoteContext.workDirProfileId
      const taskDigest = input.resolveTaskDigest(remoteContext)
      if (!binding || !identityKey || !ownerId || !requestId || !turnId || !messageId || !providerRouteId || !model ||
        !workDirProfileId || !remoteContext.currentUserMessageId || !taskDigest?.trim()) return undefined

      const now = Date.now()
      const todoId = randomUUID()
      const invocationId = call.invocationId
      const authorizationEpoch = input.getAuthorizationEpoch()
      if (!Number.isInteger(authorizationEpoch) || authorizationEpoch <= 0) return undefined
      const facts = context.facts
      const actionClass = facts.actionClass
      if (actionClass !== 'read' && actionClass !== 'write' && actionClass !== 'execute' && actionClass !== 'outbound') return undefined
      const typedActionClass: 'read' | 'write' | 'execute' | 'outbound' = actionClass
      const approval = approvalFromOutcome(primaryOutcome)
      const ttlMs = input.ttlMs ?? 24 * 60 * 60_000
      const policy = {
        lane: input.channel,
        enabled: input.isEnabled(),
        ttlMs,
        actionClass: typedActionClass,
        gate: primaryOutcome.cause === 'config-error' ? 'config-error' as const : 'eligible' as const,
        evidence: { kind: 'direct' as const, restrictionsComplete: true },
        taskDigest
      }
      const disposition = resolveImAsyncApprovalDisposition({ ...policy, approval })
      if (disposition.kind !== 'deferred') return undefined

      const rule = { ruleId: confirmation.reasonCode, factsHash: factsHash(facts) }
      const receipt = `deferred:${randomUUID()}`
      const envelope = {
        invocationId,
        requestId,
        turnId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        canonicalArgs: structuredClone(call.input),
        contentVersions: { authorizationEpoch, taskRevision: binding.revision, planRevision: binding.planRevision },
        executionContext: {
          channel: input.channel, sessionId: remoteContext.originSessionId, ownerId, identityKey, authorizationEpoch,
          invocationId, requestId, turnId, toolCallId: call.toolCallId, toolName: call.toolName,
          toolInput: structuredClone(call.input), providerRouteId, model, messageId, currentUserMessageId: remoteContext.currentUserMessageId,
          workDirProfileId, confirmationReceipt: receipt, workflowId: binding.workflowId, taskId: binding.taskId,
          stepId: binding.stepId, planRevision: binding.planRevision,
          ...(remoteContext.contextToken ? { contextToken: remoteContext.contextToken } : {})
        }
      }
      const result = await adapter.resolve({
        approval,
        eligibility: { kind: 'eligible', todoId },
        todo: {
        todoId, invocationId, reservationId: `reservation:${invocationId}`, originSessionId: remoteContext.originSessionId,
          channel: input.channel,
          identityKey, ownerId, authorizationEpoch, rule, workflowId: binding.workflowId, taskId: binding.taskId,
          stepId: binding.stepId, planRevision: binding.planRevision, taskBinding: binding,
          createdAt: now, expiresAt: now + ttlMs
        },
        ttlMs,
        policy: { ...policy, actionClass: typedActionClass, evidence: { ...policy.evidence, kind: taskDigest ? 'direct' : 'incomplete' } },
        envelope
      })
      if (!result || typeof result !== 'object' || (result as { kind?: unknown }).kind !== 'deferred') return undefined
      const rollback = async () => {
        input.todoStore.invalidate(todoId)
        input.capacity.releaseByInvocation(invocationId)
      }
      const delivered = await input.notificationDelivery.createAndSend({
        todoId, invocationId, channel: input.channel, identityKey, ownerId, authorizationEpoch, rule,
        safeActionSummary: typeof (facts.summary as { text?: unknown } | undefined)?.text === 'string' ? (facts.summary as { text: string }).text : call.toolName,
        userDelegation: taskDigest, untrustedMaterial: '', now
      })
      if (delivered.state === 'not_ready') {
        await rollback()
        return undefined
      }
      const intent = input.intentStore.get(invocationId)
      if (!intent?.checkpointId || !input.intentStore.authorizeResume(invocationId)) {
        await rollback()
        return undefined
      }
      return { kind: 'deferred', todoId, invocationId,
        checkpointRef: { checkpointId: intent.checkpointId, workflowRevision: intent.checkpointWorkflowRevision! } }
    }
  }
}

export function createImDeferredConfirmationAdapter(producer: ReturnType<typeof createImDeferredApprovalProducer>, remoteContext: RemoteContext) {
  return {
    defer: (call: Parameters<ConfirmationPort>[0]['call'], outcome: ToolConfirmationResult,
      confirmation: Parameters<ConfirmationPort>[0], context: GateConfirmationContext, primaryOutcome: ConfirmOutcome) =>
      producer.defer(call, outcome, confirmation, context, primaryOutcome, remoteContext)
  }
}
