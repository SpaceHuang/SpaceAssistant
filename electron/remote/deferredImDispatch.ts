import type { DeferredTodoRecord } from '../confirmation/deferredTodoStore'
import type { DeferredCallEnvelope } from '../confirmation/deferredEnvelopeStore'
import type { DeferredResumeRequest } from '../confirmation/deferredResumeRequestStore'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { getTaskControlRecord } from '../database/taskControl'
import { readImPolicySnapshot } from '../confirmation/imPolicyStore'
import { isRemoteAsyncApprovalTestModeEnabled, isRemoteAsyncApprovalTestTodoEnabled,
  remoteAsyncApprovalTestRunIdFromPolicyVersion } from '../confirmation/remoteAsyncApprovalTestMode'

export function recheckDeferredTaskControl(db: AppDatabase, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean {
  const context = envelope.executionContext
  const workflowId = context.workflowId
  const taskId = context.taskId
  const stepId = context.stepId
  const planRevision = context.planRevision
  if (typeof workflowId !== 'string' || typeof taskId !== 'string' || typeof stepId !== 'string' ||
    !Number.isInteger(planRevision) || workflowId !== todo.workflowId || taskId !== todo.taskId ||
    stepId !== todo.stepId || planRevision !== todo.planRevision) return false
  const control = getTaskControlRecord(db, { sessionId: todo.originSessionId, ownerId: todo.ownerId, workflowId, taskId })
  if (!control || control.controlState !== 'active' || control.planRevision !== todo.planRevision) return false
  const steps = Array.isArray(control.data.steps) ? control.data.steps as Array<{ stepId?: unknown }> : []
  const invocations = Array.isArray(control.data.outstandingInvocations)
    ? control.data.outstandingInvocations as Array<{ invocationId?: unknown; todoId?: unknown; stepId?: unknown }> : []
  return steps.some((step) => step.stepId === todo.stepId) && invocations.some((entry) =>
    entry.invocationId === todo.invocationId && entry.todoId === todo.todoId && entry.stepId === todo.stepId)
}

/** Shared production fence for direct IM deferred dispatch. It is checked both before permit claim
 * by the resume coordinator and again at the executor boundary immediately before the side effect. */
export function createDeferredImDispatchPorts(input: {
  db?: AppDatabase
  channel: 'feishu' | 'wechat'
  getAuthorizationEpoch(): number
  isEnabled(): boolean
  isOwnerAuthorized(todo: DeferredTodoRecord): boolean
  recheckTask(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean
  recheckAttachment?(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean | Promise<boolean>
  dispatch(request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): Promise<{ dispatched: boolean; result?: unknown; failureReason?: string }>
}) {
  const recheck = async (_request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope) => {
    const context = envelope.executionContext
    let policyMatches = true
    let testRunMatches = true
    const testRunId = remoteAsyncApprovalTestRunIdFromPolicyVersion(todo.policyBehaviorVersion)
    if (isRemoteAsyncApprovalTestModeEnabled() || testRunId) {
      testRunMatches = isRemoteAsyncApprovalTestTodoEnabled(todo)
    }
    if (input.db && (todo.channel === 'wechat' || todo.channel === 'feishu') && todo.policyBehaviorVersion !== undefined) {
      try {
        const snapshot = readImPolicySnapshot(getDbConnection(input.db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
        const epoch = getDbConnection(input.db).prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get() as { epoch?: number } | undefined
        const baseBehaviorVersion = testRunId
          ? todo.policyBehaviorVersion!.slice(0, todo.policyBehaviorVersion!.lastIndexOf(':dev-test:'))
          : todo.policyBehaviorVersion
        policyMatches = typeof baseBehaviorVersion === 'string' && baseBehaviorVersion === snapshot.policyBehaviorVersion &&
          todo.policyRevision === snapshot.revision && Number.isSafeInteger(todo.policyEpoch) && epoch?.epoch === todo.policyEpoch
      } catch {
        policyMatches = false
      }
    }
    const identityMatches = context.channel === input.channel && context.sessionId === todo.originSessionId &&
      context.ownerId === todo.ownerId && context.identityKey === todo.identityKey &&
      context.authorizationEpoch === todo.authorizationEpoch && context.invocationId === todo.invocationId &&
      context.toolName === envelope.toolName && JSON.stringify(context.toolInput) === JSON.stringify(envelope.canonicalArgs) &&
      context.requestId === envelope.requestId && context.turnId === envelope.turnId && context.toolCallId === envelope.toolCallId &&
      typeof context.providerRouteId === 'string' && context.providerRouteId.trim().length > 0
    const approvalMatches = todo.policyBehaviorVersion === undefined
      ? true
      : context.policyBehaviorVersion === todo.policyBehaviorVersion && context.policyRevision === todo.policyRevision &&
        context.policyEpoch === todo.policyEpoch && context.ruleId === todo.rule.ruleId && context.factsHash === todo.rule.factsHash
    const toolInput = context.toolInput && typeof context.toolInput === 'object' ? context.toolInput as Record<string, unknown> : {}
    const mediaPath = typeof toolInput.imagePath === 'string' ? toolInput.imagePath
      : typeof toolInput.filePath === 'string' ? toolInput.filePath : undefined
    const expectedAttachmentHash = envelope.contentVersions?.attachmentSha256
    const needsAttachmentBinding = todo.channel === 'wechat' && (envelope.toolName === 'wechat_send' || envelope.toolName === 'wechat_reply') && Boolean(mediaPath)
    const attachmentMatches = needsAttachmentBinding
      ? typeof expectedAttachmentHash === 'string' && /^[a-f0-9]{64}$/i.test(expectedAttachmentHash) &&
        Boolean(input.recheckAttachment && await input.recheckAttachment(todo, envelope))
      : expectedAttachmentHash === undefined
    const allowed = input.isEnabled() && testRunMatches && todo.channel === input.channel &&
      todo.authorizationEpoch === input.getAuthorizationEpoch() && input.isOwnerAuthorized(todo) &&
      policyMatches && identityMatches && approvalMatches && attachmentMatches && input.recheckTask(todo, envelope)
    return { allowed }
  }

  return {
    recheck,
    async dispatch(request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope) {
      if (input.db) {
        const closure = getDbConnection(input.db).prepare(`SELECT state,authorization_epoch FROM deferred_approval_closures
          WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=?`)
          .get(todo.channel, todo.identityKey, todo.ownerId, todo.originSessionId) as { state: string; authorization_epoch: number } | undefined
        if (closure && closure.state !== 'closed') return { dispatched: false, failureReason: '授权关闭流程正在处理中，本次操作未执行。' }
      }
      if (!(await recheck(request, todo, envelope)).allowed) return { dispatched: false, failureReason: '审批后安全复检未通过，本次操作未执行。' }
      return input.dispatch(request, todo, envelope)
    }
  }
}
