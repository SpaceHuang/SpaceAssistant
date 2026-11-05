import type { SessionStorage } from '../sessionStorage/host/ports'
import type { SessionMessageCapabilityPort } from './types'
import { createHash } from 'node:crypto'
import type { AgentSessionExecutionApproval } from '../../src/shared/domainTypes'

export type SessionMessageDrain = (sessionId: string) => void | Promise<void>

/** facts phase: resolve a user-visible target and persist an untrusted source; policy/permit remains A02. */
export function createSessionMessageService(input: {
  storage: Pick<SessionStorage, 'queries' | 'commands'>
  requestDesktopDrain: SessionMessageDrain
}): SessionMessageCapabilityPort {
  return {
    async send(request) {
      if (!request.ownerSessionId || !request.requestId || request.requestId.length > 200 || !request.content.trim()) throw new Error('SESSION_MESSAGE_INPUT_INVALID')
      const target = input.storage.queries.readSession(request.targetSessionId)
      const payloadDigest = createHash('sha256').update(request.content, 'utf8').digest('hex')
      const owner = input.storage.queries.readSession(request.ownerSessionId)
      const desktopVisible = (session: typeof target) => Boolean(session && session.ownership === 'user' && session.visibility !== 'hidden')
      if (!desktopVisible(owner)) throw new Error('SESSION_MESSAGE_CALLER_UNAVAILABLE')
      const authorization = request.authorization
      const authorized = authorization?.answerer === 'user' && Boolean(authorization.receipt?.trim()) &&
        authorization.decision.verdict === 'require-confirm' && authorization.decision.ruleIds.includes('toolkit-act-ask') &&
        Boolean(authorization.decision.decisionId.trim() && authorization.decision.dependencyFingerprint.trim() &&
          authorization.authorizationGeneration.trim() && authorization.runtimeGeneration.trim())
      const authorizationBinding = authorized && target ? {
        decisionTraceRef: authorization.decision.decisionId, permitRef: authorization.receipt!,
        ownerSessionId: request.ownerSessionId, targetSessionId: target.id, targetGeneration: target.generation,
        queueScope: 'desktop', payloadDigest, policyRevision: String(authorization.decision.policyRevision),
        authorizationGeneration: authorization.authorizationGeneration, runtimeGeneration: authorization.runtimeGeneration
      } : {}
      let accepted: ReturnType<SessionStorage['commands']['agentSessionMessages']['accept']> | undefined
      if (!target || !desktopVisible(target) || owner!.workDirProfileId !== target.workDirProfileId) {
        const prior = input.storage.commands.agentSessionMessages.readAcceptance({ ownerSessionId: request.ownerSessionId,
          requestId: request.requestId, targetSessionId: request.targetSessionId,
          payloadSha256: payloadDigest })
        if (!prior) throw new Error('SESSION_MESSAGE_TARGET_UNAVAILABLE')
        accepted = prior
      }
      if (!accepted) {
        try {
          accepted = input.storage.commands.agentSessionMessages.accept({
            ownerSessionId: request.ownerSessionId, targetSessionId: target!.id, requestId: request.requestId,
            content: request.content, authorizationBinding
          })
        } catch (error) {
          if (error instanceof Error && error.message === 'AGENT_SESSION_REQUEST_CONFLICT') throw new Error('SESSION_MESSAGE_REQUEST_CONFLICT')
          throw error
        }
      }
      if (accepted.receipt.state !== 'queued') return { accepted, wake: 'requested' as const }
      try {
        await input.requestDesktopDrain(accepted.source.targetSessionId)
        return { accepted, wake: 'requested' as const }
      } catch {
        return { accepted, wake: 'retry-pending' as const }
      }
    },
    revoke(request) {
      const before = input.storage.commands.agentSessionMessages.readSettlement(request)
      const result = input.storage.commands.agentSessionMessages.revoke(request)
      if (result.kind === 'revoked' && before?.kind === 'queued') {
        try { void Promise.resolve(input.requestDesktopDrain(before.targetSessionId)).catch(() => undefined) }
        catch { /* revoke remains durable; a later lifecycle wake retries drain */ }
      }
      return result
    },
    read: (request) => input.storage.commands.agentSessionMessages.readSettlement(request),
    prepareExecutionApproval(request) {
      if (request.answerer !== 'user' || !request.receipt?.trim() || request.decision.verdict !== 'require-confirm' ||
        !request.decision.ruleIds.includes('toolkit-act-ask') || !request.decision.decisionId.trim() ||
        !request.decision.dependencyFingerprint.trim() || !request.authorizationGeneration.trim() || !request.runtimeGeneration.trim()) return false
      const settlement = input.storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: request.ownerSessionId, requestId: request.requestId })
      if (!settlement || settlement.kind !== 'queued' || settlement.targetSessionId !== request.targetSessionId) return false
      const snapshot = input.storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: request.targetSessionId, requestId: request.requestId })
      const target = input.storage.queries.readSession(request.targetSessionId)
      const owner = input.storage.queries.readSession(request.ownerSessionId)
      if (!snapshot || snapshot.source.ownerSessionId !== request.ownerSessionId || !owner || owner.ownership !== 'user' || owner.visibility === 'hidden' ||
        !target || target.ownership !== 'user' || target.visibility === 'hidden' || owner.workDirProfileId !== target.workDirProfileId) return false
      const approval: AgentSessionExecutionApproval = {
        version: 1, originDigest: snapshot.originDigest, decisionTraceRef: request.decision.decisionId,
        permitRef: request.receipt, ownerSessionId: snapshot.source.ownerSessionId, targetSessionId: request.targetSessionId,
        targetGeneration: target.generation, requestId: snapshot.source.requestId, messageId: snapshot.source.messageId,
        queueScope: 'desktop', payloadDigest: snapshot.source.payloadSha256, policyRevision: String(request.decision.policyRevision),
        authorizationGeneration: request.authorizationGeneration, runtimeGeneration: request.runtimeGeneration, approvedAt: Date.now()
      }
      return Boolean(input.storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: request.targetSessionId,
        requestId: request.requestId, expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: snapshot.approvalDigest ?? null, approval }))
    },
    async wake(targetSessionId) {
      try {
        await input.requestDesktopDrain(targetSessionId)
        return 'requested'
      } catch {
        return 'retry-pending'
      }
    }
  }
}
