import { createHash, randomUUID } from 'node:crypto'
import type { ConfirmOutcome, ApprovalInvocationResult } from '../../src/shared/confirmation/types'
import type { DeferredApprovalCause } from '../../src/shared/confirmation/deferredApprovalResult'
import type { RemoteContext } from '../tools/types'
import type { SessionStorage } from '../sessionStorage/contracts'
import type { AppDatabase } from '../database/sqliteStore'
import type { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import type { createDeferredTodoCapacityController } from '../confirmation/deferredTodoCapacity'
import type { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import type { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import type { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredTodoAdmission } from '../confirmation/deferredTodoAdmission'
import { createDeferredApprovalAdapter } from '../confirmation/deferredApprovalAdapter'
import { resolveImAsyncApprovalDisposition } from '../confirmation/imAsyncApprovalPolicy'
import { getRemoteAsyncApprovalTestRunId } from '../confirmation/remoteAsyncApprovalTestMode'
import { commitDeferredTaskCheckpoint } from '../database/taskControl'
import { getDbConnection } from '../database/sqliteStore'
import { readImPolicySnapshot } from '../confirmation/imPolicyStore'
import type { ConfirmationPort, ToolConfirmationResult } from '../../packages/agent-sdk/src/turn'
import type { GateConfirmationContext } from '../confirmation/agentSdkConfirmationPort'

/** Resolve the authenticated inbound message by ID across its IM queue scope. */
export function resolveImTaskDigest(
  sessionStorage: Pick<SessionStorage, 'queries'> | undefined,
  remoteContext: RemoteContext
): string | undefined {
  const sessionId = remoteContext.originSessionId
  const messageId = remoteContext.currentUserMessageId
  if (!sessionStorage || !sessionId || !messageId) return undefined
  const message = sessionStorage.queries.readMessage({ sessionId, messageId })
  return message?.role === 'user' && typeof message.content === 'string' ? message.content : undefined
}

function factsHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function actionTargetFingerprint(toolName: string, input: Record<string, unknown>): string | undefined {
  const targetKeys = new Set(['path', 'filepath', 'file_path', 'target', 'targetpath', 'target_path', 'url', 'recipient', 'to', 'destination'])
  const targets = Object.entries(input)
    .filter(([key, value]) => targetKeys.has(key.toLowerCase()) && typeof value === 'string' && value.trim())
    .map(([key, value]) => [key.toLowerCase(), (value as string).trim()] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
  if (targets.length === 0) return undefined
  return createHash('sha256').update(JSON.stringify({ toolName, targets })).digest('hex')
}

function existingPendingResult(notification?: { state: string; shortCode: string }): ToolConfirmationResult {
  const userMessage = notification?.state === 'delivered'
    ? `已有同目标操作正在等待审批，通知短码：${notification.shortCode}。本次请求未执行，请先处理该审批。`
    : '已有同目标操作正在等待审批，但我无法确认原审批通知是否已送达。本次请求未执行；后续收到你的消息时系统会重试通知，请勿重复提交同一操作。'
  return { kind: 'denied', answerer: 'user', cause: 'pending-existing', userMessage }
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
  onFallback?(reason: string): void
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
    ): Promise<ToolConfirmationResult | undefined> {
      const humanRequired = context.decision.disposition === 'human-required'
      const testModeEnabled = getRemoteAsyncApprovalTestRunId() !== null
      const asyncEnabled = input.isEnabled()
      const cannotDefer = (reason: string): ToolConfirmationResult | undefined => {
        try { input.onFallback?.(reason) } catch { /* diagnostics must not affect authorization */ }
        if (!humanRequired || (!asyncEnabled && !testModeEnabled)) return undefined
        return { kind: 'unavailable', cause: 'unavailable', userMessage: '异步审批暂时无法创建，请稍后重试。' }
      }
      if (((outcome as { answerer?: unknown }).answerer !== 'agent' && !humanRequired) || remoteContext.source !== input.channel) return undefined
      if (!asyncEnabled) return testModeEnabled && humanRequired ? cannotDefer('runtime-disabled') : undefined
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
      const missingContext = [
        !binding && 'taskBinding', !identityKey && 'identityKey', !ownerId && 'authOwner', !remoteContext.originSessionId && 'originSessionId',
        !requestId && 'requestId', !turnId && 'turnId', !messageId && 'messageId', !providerRouteId && 'providerRouteId', !model && 'model',
        !workDirProfileId && 'workDirProfileId', !remoteContext.currentUserMessageId && 'currentUserMessageId', !taskDigest?.trim() && 'taskDigest'
      ].filter((field): field is string => typeof field === 'string')
      if (missingContext.length > 0) return cannotDefer(`required-context-missing:${missingContext.join(',')}`)
      if (!binding || !identityKey || !ownerId || !remoteContext.originSessionId || !requestId || !turnId || !messageId || !providerRouteId || !model ||
        !workDirProfileId || !remoteContext.currentUserMessageId || !taskDigest?.trim()) return cannotDefer('required-context-invalid')
      if (remoteContext.trackContext && remoteContext.trackContext.channel !== input.channel) return cannotDefer('track-channel-mismatch')

      const now = Date.now()
      const todoId = randomUUID()
      const invocationId = call.invocationId
      const authorizationEpoch = input.getAuthorizationEpoch()
      if (!Number.isInteger(authorizationEpoch) || authorizationEpoch <= 0) return cannotDefer('authorization-epoch-invalid')
      const facts = context.facts
      const evidenceReferences = context.evidenceReferences ?? []
      if (!Array.isArray(evidenceReferences) || evidenceReferences.length > 32 ||
        evidenceReferences.some((reference) => typeof reference !== 'string' || !reference.trim())) return cannotDefer('evidence-references-invalid')
      const actionClass = facts.actionClass
      if (actionClass !== 'read' && actionClass !== 'write' && actionClass !== 'execute' && actionClass !== 'outbound') return cannotDefer('action-class-invalid')
      const typedActionClass: 'read' | 'write' | 'execute' | 'outbound' = actionClass
      const pathTarget = facts.signals?.find((signal) => signal.kind === 'path-target')
      const outboundTarget = facts.signals?.find((signal) => signal.kind === 'outbound-target')
      const safeTargetSummary = pathTarget?.kind === 'path-target'
        ? pathTarget.zone === 'workdir-normal' ? '工作区内目标' : pathTarget.zone === 'outside-workdir' ? '工作区外目标' :
          pathTarget.zone === 'sensitive-file' ? '敏感文件目标' : '系统目录目标'
        : outboundTarget?.kind === 'outbound-target' ? `${outboundTarget.channel} 外发目标` : call.toolName
      const approval = approvalFromOutcome(primaryOutcome)
      const ttlMs = input.ttlMs ?? 24 * 60 * 60_000
      const policy = {
        lane: input.channel,
        enabled: input.isEnabled(),
        ttlMs,
        actionClass: typedActionClass,
        gate: humanRequired ? 'human-required' as const : primaryOutcome.cause === 'config-error' ? 'config-error' as const : 'eligible' as const,
        evidence: { kind: 'direct' as const, restrictionsComplete: true },
        taskDigest
      }
      const disposition = resolveImAsyncApprovalDisposition({ ...policy, approval })
      if (disposition.kind !== 'deferred') return cannotDefer(`policy-${disposition.kind}`)

      const rule = { ruleId: confirmation.reasonCode, factsHash: factsHash(facts) }
      let policyBinding: { policyBehaviorVersion: string; policyRevision: number; policyEpoch: number } | undefined
      try {
        const conn = getDbConnection(input.db)
        const snapshot = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
        const epoch = conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get() as { epoch?: number } | undefined
        if (Number.isSafeInteger(epoch?.epoch)) {
          const testRunId = getRemoteAsyncApprovalTestRunId()
          policyBinding = {
            policyBehaviorVersion: testRunId ? `${snapshot.policyBehaviorVersion}:dev-test:${testRunId}` : snapshot.policyBehaviorVersion,
            policyRevision: snapshot.revision, policyEpoch: epoch!.epoch!
          }
        }
      } catch { /* Legacy policy snapshots have no revision binding; existing channel and task fences remain active. */ }
      const priorEnvelope = input.envelopeStore.get(invocationId)
      const priorReceipt = priorEnvelope?.executionContext.confirmationReceipt
      const receipt = typeof priorReceipt === 'string' && priorReceipt.trim() ? priorReceipt : `deferred:${randomUUID()}`
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
          evidenceReferences: [...new Set(evidenceReferences)],
          ...(policyBinding ? { ...policyBinding, ruleId: rule.ruleId, factsHash: rule.factsHash } : {}),
          ...(remoteContext.contextToken ? { contextToken: remoteContext.contextToken } : {})
        }
      }
      const existingTodo = input.todoStore.getByInvocation(invocationId, {
        channel: input.channel, identityKey, ownerId, authorizationEpoch, originSessionId: remoteContext.originSessionId, rule
      }, now)
      if (existingTodo) {
        const existingEnvelope = input.envelopeStore.get(invocationId)
        const sameEnvelope = existingEnvelope && input.envelopeStore.verify(existingEnvelope, envelope).ok
        const existingIntent = input.intentStore.get(invocationId)
        const notifications = input.notificationDelivery.list(existingTodo.todoId)
        if (existingTodo.status !== 'pending' || existingTodo.originSessionId !== remoteContext.originSessionId ||
          existingTodo.workflowId !== binding.workflowId || existingTodo.taskId !== binding.taskId ||
          existingTodo.stepId !== binding.stepId || existingTodo.planRevision !== binding.planRevision || !sameEnvelope ||
          !existingIntent?.checkpointId || !input.intentStore.authorizeResume(invocationId) || notifications.length === 0) {
          return existingTodo.status === 'pending' ? existingPendingResult(notifications.at(-1)) : cannotDefer('existing-todo-binding-invalid')
        }
        const causeValue = humanRequired ? 'human-required' : primaryOutcome.cause
        const causes: readonly DeferredApprovalCause[] = ['human-required', 'agent-deny', 'agent-undetermined', 'unavailable',
          'timeout', 'unparsable', 'outbound-requires-human', 'insufficient-delegation-evidence']
        const cause = causes.find((candidate) => candidate === causeValue) ?? 'agent-undetermined'
        return { kind: 'deferred', todoId: existingTodo.todoId, invocationId, cause, executionState: 'not-executed' as const,
          retryable: false, nextStep: 'await-user' as const,
          checkpointRef: { checkpointId: existingIntent.checkpointId, workflowRevision: existingIntent.checkpointWorkflowRevision! } }
      }
      const targetFingerprint = actionTargetFingerprint(call.toolName, call.input as Record<string, unknown>)
      if (targetFingerprint) {
        const pending = getDbConnection(input.db).prepare(`SELECT todo_id,invocation_id FROM deferred_todos
          WHERE channel=? AND identity_key=? AND owner_id=? AND authorization_epoch=? AND origin_session_id=?
            AND state='pending' AND expires_at>? ORDER BY created_at,todo_id`)
          .all(input.channel, identityKey!, ownerId!, authorizationEpoch, remoteContext.originSessionId!, now) as Array<{ todo_id: string; invocation_id: string }>
        for (const candidate of pending) {
          if (candidate.invocation_id === invocationId) continue
          const prior = input.envelopeStore.get(candidate.invocation_id)
          if (prior && actionTargetFingerprint(prior.toolName, prior.canonicalArgs) === targetFingerprint) {
            return existingPendingResult(input.notificationDelivery.list(candidate.todo_id).at(-1))
          }
        }
      }
      const result = await adapter.resolve({
        approval,
        eligibility: { kind: 'eligible', todoId },
        todo: {
        todoId, invocationId, reservationId: `reservation:${invocationId}`, originSessionId: remoteContext.originSessionId,
          ...(remoteContext.trackContext ? { trackId: remoteContext.trackContext.trackId } : {}),
          channel: input.channel,
          identityKey, ownerId, authorizationEpoch, rule, workflowId: binding.workflowId, taskId: binding.taskId,
          stepId: binding.stepId, planRevision: binding.planRevision, taskBinding: binding,
          ...(policyBinding ? { policyBehaviorVersion: policyBinding.policyBehaviorVersion } : {}),
          createdAt: now, expiresAt: now + ttlMs
        },
        ttlMs,
        policy: { ...policy, actionClass: typedActionClass, evidence: { ...policy.evidence, kind: taskDigest ? 'direct' : 'incomplete' } },
        envelope
      })
      if (!result || typeof result !== 'object' || (result as { kind?: unknown }).kind !== 'deferred') return cannotDefer('todo-admission-failed')
      const rollback = async () => {
        input.todoStore.invalidate(todoId)
        input.capacity.releaseByInvocation(invocationId)
      }
      const delivered = await input.notificationDelivery.createAndSend({
        todoId, invocationId, channel: input.channel, identityKey, ownerId, authorizationEpoch, rule,
        safeActionSummary: typeof (facts.summary as { text?: unknown } | undefined)?.text === 'string' ? (facts.summary as { text: string }).text : call.toolName,
        safeTargetSummary,
        impactSummary: `${facts.actionClass}, ${facts.baseRiskLevel ?? context.decision.riskLevel ?? 'unknown'} impact`,
        reasonSummary: confirmation.reasonCode,
        userDelegation: taskDigest, untrustedMaterial: '', now
      })
      if (delivered.state === 'not_ready') {
        await rollback()
        return cannotDefer('notification-not-ready')
      }
      const intent = input.intentStore.get(invocationId)
      if (!intent?.checkpointId || !input.intentStore.authorizeResume(invocationId)) {
        await rollback()
        return cannotDefer('checkpoint-not-authorized')
      }
      const causeValue = (result as { cause?: unknown }).cause
      const causes: readonly DeferredApprovalCause[] = ['human-required', 'agent-deny', 'agent-undetermined', 'unavailable',
        'timeout', 'unparsable', 'outbound-requires-human', 'insufficient-delegation-evidence']
      const cause = causes.find((candidate) => candidate === causeValue) ?? (humanRequired ? 'human-required' : 'agent-undetermined')
      return { kind: 'deferred', todoId, invocationId, cause, executionState: 'not-executed' as const,
        retryable: false, nextStep: 'await-user' as const,
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
