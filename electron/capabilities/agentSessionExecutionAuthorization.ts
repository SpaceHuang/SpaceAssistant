import type { AgentSessionExecutionFinalCheckFacts } from '../../src/shared/domainTypes'
import { decide } from '../../src/shared/policy/policyEngine'
import type { ContentFacts, ExecutionContext, PolicyRule } from '../../src/shared/confirmation/types'
import type { ToolsConfig } from '../../src/shared/domainTypes'
import type { SessionStorage } from '../sessionStorage/host/ports'
import { createHash, randomUUID } from 'node:crypto'

export type AgentSessionExecutionAuthority = Readonly<{
  policyRevision: string
  authorizationGeneration: string
  runtimeGeneration: string
}>

export type AgentSessionExecutionApprovalResolution =
  | Readonly<{ kind: 'approved'; finalCheck: (facts: AgentSessionExecutionFinalCheckFacts) => boolean;
      workDirSnapshot?: Readonly<{ workDir: string; binding: string }> }>
  | Readonly<{ kind: 'waiting'; reason: 'approval-missing' | 'approval-stale' | 'source-mismatch' }>
  | Readonly<{ kind: 'rejected'; reason: 'policy-rejected'; ruleId: string }>

export type AgentSessionExecutionPolicyEvaluation = Readonly<{ kind: 'allow' }> |
  Readonly<{ kind: 'require-confirm'; ruleId: string }> |
  Readonly<{ kind: 'deny'; ruleId: string }>

export type AgentSessionExecutionReauthorization = 'approved' | 'policy-rejected' | 'user-rejected' | 'waiting'

/** Re-enter the shared toolkit policy with host-derived target identity and no message body. */
export function evaluateAgentSessionExecutionPolicy(input: {
  sessionId: string
  rules: PolicyRule[]
  config: ToolsConfig
}): AgentSessionExecutionPolicyEvaluation {
  const facts: ContentFacts = { toolName: 'toolkit.call', actionClass: 'execute', baseRiskLevel: 'medium',
    signals: [{ kind: 'toolkit-capability', capabilityId: 'action.session.message.send', risk: 'act' }],
    summary: { text: '跨会话来信执行权限重审' } }
  const context: ExecutionContext = { lane: 'desktop', origin: { kind: 'direct-owner' }, sessionId: input.sessionId }
  const decision = decide(facts, context, input.rules, { cache: { lookup: () => null }, config: { ...input.config }, migrationComplete: true })
  return decision.type === 'deny' ? { kind: 'deny', ruleId: decision.ruleId }
    : decision.type === 'require-confirm' ? { kind: 'require-confirm', ruleId: decision.ruleId } : { kind: 'allow' }
}

export type AgentSessionExecutionAuthorizationPort = Readonly<{
  resolve(inputRequest: { sessionId: string; requestId: string; messageId: string }): AgentSessionExecutionApprovalResolution
  reauthorize?(inputRequest: { sessionId: string; requestId: string; messageId: string }): Promise<AgentSessionExecutionReauthorization>
}>

/**
 * facts/final-check: resolve the persisted user approval before prepare, then re-read authority
 * inside the atomic claim callback. The protected source keeps historical sender identity after
 * sender deletion; target ownership and the approved target object remain live final-check facts.
 * A stale approval re-enters current target policy; explicit deny settles, while confirmation stays queued.
 */
export function createAgentSessionExecutionAuthorization(input: {
  storage: Pick<SessionStorage, 'queries' | 'commands'>
  readCurrentAuthority: () => AgentSessionExecutionAuthority | undefined
  resolveWorkDirProfileId?: (sessionId: string) => string | undefined
  resolveWorkDirSnapshot?: (sessionId: string) => Readonly<{ workDir: string; binding: string }> | undefined
  evaluateCurrentPolicy?: (input: { sessionId: string; requestId: string; messageId: string;
    source: import('../../src/shared/domainTypes').AgentSessionInputSource }) => AgentSessionExecutionPolicyEvaluation | undefined
  requestUserConfirmation?: (input: { sessionId: string; requestId: string; messageId: string; ruleId: string;
    decisionTraceRef: string; source: import('../../src/shared/domainTypes').AgentSessionInputSource }) => Promise<'approved' | 'rejected' | 'waiting'>
}): AgentSessionExecutionAuthorizationPort {
  const inFlight = new Map<string, Promise<AgentSessionExecutionReauthorization>>()
  return {
    resolve(inputRequest: { sessionId: string; requestId: string; messageId: string }): AgentSessionExecutionApprovalResolution {
      const snapshot = input.storage.commands.agentSessionMessages.readApprovalSnapshot({
        sessionId: inputRequest.sessionId, requestId: inputRequest.requestId
      })
      if (!snapshot?.approval) return { kind: 'waiting', reason: 'approval-missing' }
      const { source, approval, originDigest, approvalDigest } = snapshot
      const target = input.storage.queries.readSession(inputRequest.sessionId)
      const currentProfileId = target && (input.resolveWorkDirProfileId ? input.resolveWorkDirProfileId(target.id) : target.workDirProfileId ?? 'default')
      const workDirSnapshot = target && input.resolveWorkDirSnapshot?.(target.id)
      if (!target || source.kind !== 'agent-session' || source.targetSessionId !== inputRequest.sessionId ||
        source.requestId !== inputRequest.requestId || source.messageId !== inputRequest.messageId ||
        !target.id || target.ownership !== 'user' || target.visibility === 'hidden' ||
        approval.originDigest !== originDigest || approval.ownerSessionId !== source.ownerSessionId ||
        approval.targetSessionId !== source.targetSessionId || approval.targetGeneration !== target.generation ||
        approval.workDirProfileId !== currentProfileId ||
        (input.resolveWorkDirSnapshot !== undefined && (!workDirSnapshot || workDirSnapshot.binding !== approval.workDirProfileId)) ||
        approval.requestId !== source.requestId || approval.messageId !== source.messageId || approval.queueScope !== 'desktop' ||
        approval.payloadDigest !== source.payloadSha256) {
        return { kind: 'waiting', reason: 'source-mismatch' }
      }
      const binding = source.authorizationBinding
      // The source binding records the original send authorization and remains immutable. A queued
      // message may receive a newer user-confirmed approval after policy changes; CAS storage binds
      // that approval to this same source, and current authority below validates the new trace.
      if (binding.ownerSessionId !== source.ownerSessionId || binding.workDirProfileId !== approval.workDirProfileId ||
        binding.targetSessionId !== source.targetSessionId || binding.targetGeneration !== target.generation ||
        binding.queueScope !== 'desktop' || binding.payloadDigest !== source.payloadSha256) {
        return { kind: 'waiting', reason: 'source-mismatch' }
      }
      const currentAuthority = input.readCurrentAuthority()
      if (!currentAuthority || currentAuthority.policyRevision !== approval.policyRevision ||
        currentAuthority.authorizationGeneration !== approval.authorizationGeneration || currentAuthority.runtimeGeneration !== approval.runtimeGeneration) {
        const reevaluated = input.evaluateCurrentPolicy?.({ sessionId: inputRequest.sessionId,
          requestId: inputRequest.requestId, messageId: inputRequest.messageId, source })
        if (reevaluated?.kind === 'deny' && reevaluated.ruleId.trim()) {
          return { kind: 'rejected', reason: 'policy-rejected', ruleId: reevaluated.ruleId }
        }
        // A policy allow is not a fresh execution approval. Never stamp the old permit with new generations.
        return { kind: 'waiting', reason: 'approval-stale' }
      }
      const authority = { ...currentAuthority }
      const targetWorkDirProfileId = approval.workDirProfileId
      return {
        kind: 'approved',
        ...(workDirSnapshot ? { workDirSnapshot } : {}),
        finalCheck: (facts) => {
          const current = input.readCurrentAuthority()
          const currentTarget = input.storage.queries.readSession(inputRequest.sessionId)
          const currentProfileId = currentTarget && (input.resolveWorkDirProfileId ? input.resolveWorkDirProfileId(currentTarget.id) : currentTarget.workDirProfileId ?? 'default')
          const currentWorkDirSnapshot = currentTarget && input.resolveWorkDirSnapshot?.(currentTarget.id)
          return Boolean(current && current.policyRevision === authority.policyRevision &&
            current.authorizationGeneration === authority.authorizationGeneration && current.runtimeGeneration === authority.runtimeGeneration &&
            currentTarget?.ownership === 'user' && currentTarget.visibility !== 'hidden' && currentTarget.generation === target.generation &&
            currentProfileId === targetWorkDirProfileId &&
            (input.resolveWorkDirSnapshot === undefined || (currentWorkDirSnapshot?.binding === targetWorkDirProfileId &&
              currentWorkDirSnapshot.workDir === workDirSnapshot?.workDir)) &&
            facts.originDigest === originDigest && facts.approvalDigest === approvalDigest &&
            facts.targetGeneration === target.generation && facts.source.ownerSessionId === source.ownerSessionId &&
            facts.source.targetSessionId === source.targetSessionId && facts.source.requestId === source.requestId &&
            facts.source.messageId === source.messageId && facts.approval.decisionTraceRef === approval.decisionTraceRef &&
            facts.source.authorizationBinding.workDirProfileId === approval.workDirProfileId &&
            facts.approval.permitRef === approval.permitRef && facts.approval.policyRevision === approval.policyRevision &&
            facts.approval.authorizationGeneration === approval.authorizationGeneration && facts.approval.runtimeGeneration === approval.runtimeGeneration)
        }
      }
    },
    async reauthorize(inputRequest) {
      const targetForKey = input.storage.queries.readSession(inputRequest.sessionId)
      const authorityForKey = input.readCurrentAuthority()
      const workDirForKey = targetForKey && (input.resolveWorkDirSnapshot?.(targetForKey.id)?.binding ??
        input.resolveWorkDirProfileId?.(targetForKey.id))
      const key = JSON.stringify([inputRequest.sessionId, inputRequest.requestId, inputRequest.messageId,
        targetForKey?.generation, workDirForKey, authorityForKey?.policyRevision,
        authorityForKey?.authorizationGeneration, authorityForKey?.runtimeGeneration])
      const existing = inFlight.get(key)
      if (existing) return existing
      const operation = (async (): Promise<AgentSessionExecutionReauthorization> => {
        const snapshot = input.storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: inputRequest.sessionId,
          requestId: inputRequest.requestId })
        if (!snapshot || snapshot.source.messageId !== inputRequest.messageId || snapshot.source.targetSessionId !== inputRequest.sessionId ||
          snapshot.source.requestId !== inputRequest.requestId) return 'waiting'
        const currentAuthority = input.readCurrentAuthority()
        const target = input.storage.queries.readSession(inputRequest.sessionId)
        const workDirSnapshot = target && input.resolveWorkDirSnapshot?.(target.id)
        const workDirBinding = workDirSnapshot?.binding ?? (target && input.resolveWorkDirProfileId?.(target.id))
        if (!currentAuthority || !target || target.ownership !== 'user' || target.visibility === 'hidden' || !workDirBinding ||
          snapshot.source.authorizationBinding.workDirProfileId !== workDirBinding) return 'waiting'
        const policy = input.evaluateCurrentPolicy?.({ ...inputRequest, source: snapshot.source })
        if (policy?.kind === 'deny') return 'policy-rejected'
        if (policy?.kind !== 'require-confirm' || !input.requestUserConfirmation) return 'waiting'
        const decisionTraceRef = `agent-session-reauthorization:${createHash('sha256').update(JSON.stringify({
          sessionId: inputRequest.sessionId, requestId: inputRequest.requestId, messageId: inputRequest.messageId,
          authority: currentAuthority, ruleId: policy.ruleId
        })).digest('hex')}`
        const confirmation = await input.requestUserConfirmation({ ...inputRequest, ruleId: policy.ruleId, decisionTraceRef, source: snapshot.source })
        if (confirmation === 'rejected') return 'user-rejected'
        if (confirmation !== 'approved') return 'waiting'

        const latestSnapshot = input.storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: inputRequest.sessionId,
          requestId: inputRequest.requestId })
        const latestAuthority = input.readCurrentAuthority()
        const latestTarget = input.storage.queries.readSession(inputRequest.sessionId)
        const latestWorkDir = latestTarget && input.resolveWorkDirSnapshot?.(latestTarget.id)
        const latestBinding = latestWorkDir?.binding ?? (latestTarget && input.resolveWorkDirProfileId?.(latestTarget.id))
        const latestPolicy = latestSnapshot && input.evaluateCurrentPolicy?.({ ...inputRequest, source: latestSnapshot.source })
        if (!latestSnapshot || latestSnapshot.originDigest !== snapshot.originDigest || latestSnapshot.approvalDigest !== snapshot.approvalDigest ||
          !latestAuthority || latestAuthority.policyRevision !== currentAuthority.policyRevision ||
          latestAuthority.authorizationGeneration !== currentAuthority.authorizationGeneration || latestAuthority.runtimeGeneration !== currentAuthority.runtimeGeneration ||
          !latestTarget || latestTarget.generation !== target.generation || latestBinding !== workDirBinding ||
          latestSnapshot.source.messageId !== inputRequest.messageId || latestPolicy?.kind !== 'require-confirm' || latestPolicy.ruleId !== policy.ruleId) return 'waiting'
        const approval: import('../../src/shared/domainTypes').AgentSessionExecutionApproval = {
          version: 1, originDigest: latestSnapshot.originDigest, decisionTraceRef,
          permitRef: `user-confirmation:${randomUUID()}`, ownerSessionId: latestSnapshot.source.ownerSessionId,
          targetSessionId: latestSnapshot.source.targetSessionId, targetGeneration: latestTarget.generation,
          workDirProfileId: workDirBinding, requestId: latestSnapshot.source.requestId, messageId: latestSnapshot.source.messageId,
          queueScope: 'desktop', payloadDigest: latestSnapshot.source.payloadSha256,
          policyRevision: latestAuthority.policyRevision, authorizationGeneration: latestAuthority.authorizationGeneration,
          runtimeGeneration: latestAuthority.runtimeGeneration, approvedAt: Date.now()
        }
        const refreshed = input.storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: inputRequest.sessionId,
          requestId: inputRequest.requestId, expectedOriginDigest: latestSnapshot.originDigest,
          expectedApprovalDigest: latestSnapshot.approvalDigest ?? null, approval })
        return refreshed ? 'approved' : 'waiting'
      })()
      inFlight.set(key, operation)
      try { return await operation } finally { if (inFlight.get(key) === operation) inFlight.delete(key) }
    }
  }
}
