import { randomUUID } from 'node:crypto'
import { readImPolicySnapshot } from '../confirmation/imPolicyStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import type { DeferredCallEnvelope } from '../confirmation/deferredEnvelopeStore'
import type { createDeferredTodoStore, DeferredTodoAuthorization, DeferredTodoRecord } from '../confirmation/deferredTodoStore'
import type { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import type { DeferredResumeRequest } from '../confirmation/deferredResumeRequestStore'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { buildDeferredApprovalAuditEvent } from '../confirmation/deferredApprovalAudit'
import { tryClaimRemoteSession, releaseRemoteSession } from './remoteAgentRegistry'
import { runInTransaction } from '../database/transaction'

type Recheck = (request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope) => Promise<{ allowed: boolean }>
type Dispatch = (request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope) => Promise<{ dispatched: boolean; failureReason?: string }>

/** Re-enter a fresh IM gate for parked calls after a policy revision; old receipts never authorize this transition. */
export function createDeferredPolicyReevaluation(input: {
  db: AppDatabase
  channel: 'feishu' | 'wechat'
  todoStore: ReturnType<typeof createDeferredTodoStore>
  envelopeStore: { get(invocationId: string): DeferredCallEnvelope | null; updatePolicy(invocationId: string, policy: {
    ruleId: string; factsHash: string; policyBehaviorVersion: string; policyRevision: number; policyEpoch: number; confirmationReceipt?: string
  }): DeferredCallEnvelope | null }
  notificationDelivery: ReturnType<typeof createDeferredApprovalNotificationDelivery>
  enabled(): boolean
  authorizationEpoch(): number
  ownerAuthorized(todo: DeferredTodoRecord): boolean
  recheckTask(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean
  recheckAttachment?(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean | Promise<boolean>
  reauthorize(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): Promise<{
    decision: 'allow' | 'ask' | 'deny'; rule: { ruleId: string; factsHash: string }; reasonSummary?: string
  }>
  recheck: Recheck
  dispatch: Dispatch
  maxParallel: number
  scheduleRetry?: (delayMs: number, callback: () => void) => void
  wake(sessionId: string): void | Promise<void>
  audit(event: SecurityAuditEvent): void
}) {
  const executionResults = createDeferredExecutionResultStore(input.db)
  const inFlight = new Set<string>()
  const policySnapshot = () => {
    const conn = getDbConnection(input.db)
    const snapshot = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    const epoch = conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get() as { epoch?: number } | undefined
    return epoch && Number.isSafeInteger(epoch.epoch)
      ? { policyBehaviorVersion: snapshot.policyBehaviorVersion, policyRevision: snapshot.revision, policyEpoch: epoch.epoch! }
      : null
  }
  const authorization = (todo: DeferredTodoRecord): DeferredTodoAuthorization => ({ channel: todo.channel, identityKey: todo.identityKey,
    ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, originSessionId: todo.originSessionId, rule: todo.rule })
  const recordFailure = async (todo: DeferredTodoRecord, revision: number, reason: string) => {
    const dispatchKey = `policy-recheck-deny:${todo.todoId}:${revision}`
    if (!executionResults.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey }).ok) return
    executionResults.commitResult(todo.todoId, { kind: 'failed', outputRef: `deferred-result:${todo.invocationId}`,
      value: { success: false, error: reason } })
    await input.wake(todo.originSessionId)
  }

  return {
    async processInvalidated() {
      const results: Array<{ todoId: string; outcome: 'allow' | 'ask' | 'deny' | 'stale' | 'unavailable' }> = []
      const retryAfterPolicyRace = () => {
        const retry = () => { void this.processInvalidated() }
        if (input.scheduleRetry) input.scheduleRetry(100, retry)
        else { const timer = setTimeout(retry, 100); timer.unref?.() }
      }
      for (const todo of input.todoStore.listInvalidatedByPolicyChange(input.channel)) {
        if (inFlight.has(todo.todoId)) continue
        inFlight.add(todo.todoId)
        let leaseOwner: string | undefined
        let observedPolicyRevision: number | undefined
        let executionStarted = false
        try {
          const envelope = input.envelopeStore.get(todo.invocationId)
          if (!envelope || envelope.invocationId !== todo.invocationId || todo.expiresAt <= Date.now() ||
            !input.enabled() || todo.authorizationEpoch !== input.authorizationEpoch() || !input.ownerAuthorized(todo) ||
            !input.recheckTask(todo, envelope) || input.recheckAttachment && !(await input.recheckAttachment(todo, envelope))) {
            input.todoStore.completePolicyInvalidation(todo.todoId)
            results.push({ todoId: todo.todoId, outcome: 'unavailable' })
            continue
          }
          const before = policySnapshot()
          if (!before) { results.push({ todoId: todo.todoId, outcome: 'stale' }); continue }
          observedPolicyRevision = before.policyRevision
          const decision = await input.reauthorize(todo, envelope)
          const current = policySnapshot()
          if (!current || current.policyRevision !== before.policyRevision || current.policyEpoch !== before.policyEpoch ||
            current.policyBehaviorVersion !== before.policyBehaviorVersion) {
            retryAfterPolicyRace()
            results.push({ todoId: todo.todoId, outcome: 'stale' })
            continue
          }
          if (decision.decision === 'deny') {
            await recordFailure(todo, current.policyRevision, decision.reasonSummary ?? '策略变更后，本次操作被安全策略拒绝，未执行。')
            input.todoStore.completePolicyInvalidation(todo.todoId)
            results.push({ todoId: todo.todoId, outcome: 'deny' })
            continue
          }
          if (!decision.rule.ruleId.trim() || !/^[a-f0-9]{64}$/i.test(decision.rule.factsHash)) {
            input.todoStore.completePolicyInvalidation(todo.todoId)
            results.push({ todoId: todo.todoId, outcome: 'unavailable' })
            continue
          }
          const now = Date.now()
          const requestId = `policy-recheck-allow:${todo.todoId}:${current.policyRevision}`
          if (decision.decision === 'allow') {
            const lease = tryClaimRemoteSession(todo.originSessionId, requestId, input.maxParallel)
            if (lease !== 'ok') {
              const retry = () => { void this.processInvalidated() }
              if (input.scheduleRetry) input.scheduleRetry(500, retry)
              else { const timer = setTimeout(retry, 500); timer.unref?.() }
              results.push({ todoId: todo.todoId, outcome: 'unavailable' })
              continue
            }
            leaseOwner = requestId
          }
          const rebound = input.todoStore.rebindAfterPolicyChange(todo.todoId, authorization(todo), decision.rule)
          if (!rebound) {
            const latest = policySnapshot()
            if (latest && (latest.policyRevision !== current.policyRevision || latest.policyEpoch !== current.policyEpoch ||
              latest.policyBehaviorVersion !== current.policyBehaviorVersion)) retryAfterPolicyRace()
            else input.todoStore.completePolicyInvalidation(todo.todoId)
            results.push({ todoId: todo.todoId, outcome: 'stale' })
            continue
          }
          const updatedEnvelope = input.envelopeStore.updatePolicy(todo.invocationId, { ...decision.rule, ...current,
            confirmationReceipt: `policy-recheck:${randomUUID()}` })
          if (!updatedEnvelope) {
            input.todoStore.invalidate(rebound.todoId)
            results.push({ todoId: todo.todoId, outcome: 'unavailable' })
            continue
          }
          if (decision.decision === 'ask') {
            const previous = input.notificationDelivery.list(todo.todoId).at(-1)
            if (!previous) {
              input.todoStore.invalidate(rebound.todoId)
              results.push({ todoId: todo.todoId, outcome: 'unavailable' })
              continue
            }
            const section = (kind: string) => previous.dto.sections.find((entry) => entry.kind === kind)?.text
            const notice = await input.notificationDelivery.replaceAndSend({ todoId: todo.todoId, invocationId: todo.invocationId,
              channel: todo.channel, identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch,
              rule: decision.rule, replacesNotificationVersion: previous.notificationVersion,
              safeActionSummary: section('action-summary') ?? '原待执行操作', safeTargetSummary: section('target-summary'),
              impactSummary: section('impact-summary'), reasonSummary: decision.reasonSummary ?? '策略变更后仍需人工批准',
              userDelegation: section('user-delegation') ?? '请核对本次操作后再决定', untrustedMaterial: '',
              attachmentInfo: previous.dto.attachmentInfo })
            if (notice.state === 'not_ready') input.todoStore.invalidate(rebound.todoId)
            results.push({ todoId: todo.todoId, outcome: notice.state === 'not_ready' ? 'unavailable' : 'ask' })
            continue
          }
          const request: DeferredResumeRequest = { requestId, reasonKey: requestId, todoId: todo.todoId, invocationId: todo.invocationId,
            sessionId: todo.originSessionId, channel: todo.channel, identityKey: todo.identityKey, ownerId: todo.ownerId,
            authorizationEpoch: todo.authorizationEpoch, rule: decision.rule,
            notificationVersion: Math.max(1, (input.notificationDelivery.list(todo.todoId).at(-1)?.notificationVersion ?? 0) + 1),
            messageId: typeof updatedEnvelope.executionContext.messageId === 'string' ? updatedEnvelope.executionContext.messageId : 'policy-recheck',
            state: 'dispatching', createdAt: now, updatedAt: now }
          const checked = await input.recheck(request, rebound, updatedEnvelope)
          const auth = { ...authorization(rebound), rule: decision.rule }
          const claimed = checked.allowed && runInTransaction(getDbConnection(input.db), () => {
            if (!input.todoStore.claimForDispatch(todo.todoId, auth, now)) return false
            if (!input.todoStore.markConsumed(todo.todoId, auth, now)) throw new Error('DEFERRED_POLICY_RECHECK_CONSUME_FAILED')
            return true
          })
          if (!claimed) {
            input.todoStore.invalidate(todo.todoId)
            await recordFailure(todo, current.policyRevision, '策略变更后的最终检查未通过，本次操作未执行。')
            results.push({ todoId: todo.todoId, outcome: 'deny' })
            continue
          }
          input.audit(buildDeferredApprovalAuditEvent({ kind: 'dispatch', lane: todo.channel, sessionId: todo.originSessionId,
            todoId: todo.todoId, invocationId: todo.invocationId, consumed: true,
            policyBehaviorVersion: current.policyBehaviorVersion, policyRevision: current.policyRevision, dispatchKey: requestId }))
          executionStarted = true
          const dispatched = await input.dispatch(request, rebound, updatedEnvelope)
          if (!dispatched.dispatched) await recordFailure(todo, current.policyRevision,
            dispatched.failureReason ?? '策略变更后的派发检查未通过，本次操作未执行。')
          results.push({ todoId: todo.todoId, outcome: dispatched.dispatched ? 'allow' : 'deny' })
        } catch (error) {
          // Deliberately log no exception text: adapter errors may include provider data or paths.
          console.error('[deferredPolicyReevaluation] recheck unavailable')
          if (observedPolicyRevision !== undefined && !executionStarted) {
            await recordFailure(todo, observedPolicyRevision, '策略变更后的复检材料不可用，本次操作未执行。')
            input.todoStore.completePolicyInvalidation(todo.todoId)
          }
          results.push({ todoId: todo.todoId, outcome: 'unavailable' })
        } finally {
          if (leaseOwner) releaseRemoteSession(todo.originSessionId, leaseOwner)
          inFlight.delete(todo.todoId)
        }
      }
      return results
    }
  }
}
