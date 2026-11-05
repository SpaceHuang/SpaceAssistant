import type { AgentSessionExecutionFinalCheckFacts } from '../../src/shared/domainTypes'
import { decide } from '../../src/shared/policy/policyEngine'
import type { ContentFacts, ExecutionContext, PolicyRule } from '../../src/shared/confirmation/types'
import type { ToolsConfig } from '../../src/shared/domainTypes'
import type { SessionStorage } from '../sessionStorage/host/ports'

export type AgentSessionExecutionAuthority = Readonly<{
  policyRevision: string
  authorizationGeneration: string
  runtimeGeneration: string
}>

export type AgentSessionExecutionApprovalResolution =
  | Readonly<{ kind: 'approved'; finalCheck: (facts: AgentSessionExecutionFinalCheckFacts) => boolean }>
  | Readonly<{ kind: 'waiting'; reason: 'approval-missing' | 'approval-stale' | 'source-mismatch' }>
  | Readonly<{ kind: 'rejected'; reason: 'policy-rejected'; ruleId: string }>

export type AgentSessionExecutionPolicyEvaluation = Readonly<{ kind: 'allow' | 'require-confirm' }> |
  Readonly<{ kind: 'deny'; ruleId: string }>

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
    : decision.type === 'require-confirm' ? { kind: 'require-confirm' } : { kind: 'allow' }
}

export type AgentSessionExecutionAuthorizationPort = Readonly<{
  resolve(inputRequest: { sessionId: string; requestId: string; messageId: string }): AgentSessionExecutionApprovalResolution
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
  evaluateCurrentPolicy?: (input: { sessionId: string; requestId: string; messageId: string;
    source: import('../../src/shared/domainTypes').AgentSessionInputSource }) => AgentSessionExecutionPolicyEvaluation | undefined
}): AgentSessionExecutionAuthorizationPort {
  return {
    resolve(inputRequest: { sessionId: string; requestId: string; messageId: string }): AgentSessionExecutionApprovalResolution {
      const snapshot = input.storage.commands.agentSessionMessages.readApprovalSnapshot({
        sessionId: inputRequest.sessionId, requestId: inputRequest.requestId
      })
      if (!snapshot?.approval) return { kind: 'waiting', reason: 'approval-missing' }
      const { source, approval, originDigest, approvalDigest } = snapshot
      const target = input.storage.queries.readSession(inputRequest.sessionId)
      const currentProfileId = target && (input.resolveWorkDirProfileId ? input.resolveWorkDirProfileId(target.id) : target.workDirProfileId ?? 'default')
      if (!target || source.kind !== 'agent-session' || source.targetSessionId !== inputRequest.sessionId ||
        source.requestId !== inputRequest.requestId || source.messageId !== inputRequest.messageId ||
        !target.id || target.ownership !== 'user' || target.visibility === 'hidden' ||
        approval.originDigest !== originDigest || approval.ownerSessionId !== source.ownerSessionId ||
        approval.targetSessionId !== source.targetSessionId || approval.targetGeneration !== target.generation ||
        approval.workDirProfileId !== currentProfileId ||
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
        finalCheck: (facts) => {
          const current = input.readCurrentAuthority()
          const currentTarget = input.storage.queries.readSession(inputRequest.sessionId)
          const currentProfileId = currentTarget && (input.resolveWorkDirProfileId ? input.resolveWorkDirProfileId(currentTarget.id) : currentTarget.workDirProfileId ?? 'default')
          return Boolean(current && current.policyRevision === authority.policyRevision &&
            current.authorizationGeneration === authority.authorizationGeneration && current.runtimeGeneration === authority.runtimeGeneration &&
            currentTarget?.ownership === 'user' && currentTarget.visibility !== 'hidden' && currentTarget.generation === target.generation &&
            currentProfileId === targetWorkDirProfileId &&
            facts.originDigest === originDigest && facts.approvalDigest === approvalDigest &&
            facts.targetGeneration === target.generation && facts.source.ownerSessionId === source.ownerSessionId &&
            facts.source.targetSessionId === source.targetSessionId && facts.source.requestId === source.requestId &&
            facts.source.messageId === source.messageId && facts.approval.decisionTraceRef === approval.decisionTraceRef &&
            facts.source.authorizationBinding.workDirProfileId === approval.workDirProfileId &&
            facts.approval.permitRef === approval.permitRef && facts.approval.policyRevision === approval.policyRevision &&
            facts.approval.authorizationGeneration === approval.authorizationGeneration && facts.approval.runtimeGeneration === approval.runtimeGeneration)
        }
      }
    }
  }
}
