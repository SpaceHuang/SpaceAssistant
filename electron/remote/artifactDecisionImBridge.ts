import type { RemoteArtifactDecisionOwner } from '../../src/shared/artifactDecisionTypes'
import type { RemoteArtifactDecisionAuditEvent } from '../tools/types'
import {
  findArtifactDecisionTombstone,
  listArtifactDecisionCandidates,
  submitArtifactDecisionResponse,
  type ArtifactDecisionCandidate
} from '../artifacts/artifactDecisionBridge'
import {
  buildArtifactDecisionUsageHint,
  extractArtifactDecisionReplyPrefix,
  parseArtifactDecisionReplyBody,
  resolveRemoteArtifactDecisionChoice
} from './artifactDecisionRemote'

export type ArtifactDecisionInboundResult =
  | { handled: false; reason: 'not_decision' | 'no_candidates' }
  | {
      handled: true
      reason:
        | 'resolved'
        | 'usage_hint'
        | 'ambiguous'
        | 'unknown_decision_id'
        | 'stale'
        | 'binding_mismatch'
        | 'invalid'
        | 'authorization_revoked'
    }

export type AuthorizeBeforeArtifactDecisionSubmit = () =>
  | { ok: true }
  | { ok: false; reason: 'authorization_revoked' }

export type ArtifactDecisionInboundIdentity = Pick<
  RemoteArtifactDecisionOwner,
  'source' | 'authOwner' | 'privateChatTarget'
>

function safeAuditFields(
  event: RemoteArtifactDecisionAuditEvent,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...extra }
  delete fields.raw
  delete fields.input
  delete fields.rename
  delete fields.directory
  delete fields.value
  if (event === 'ambiguous') {
    return { candidateCount: fields.candidateCount }
  }
  if (event === 'resolved') {
    return {
      decisionId: fields.decisionId,
      choiceKey: fields.choiceKey,
      hasInput: fields.hasInput === true
    }
  }
  if (event === 'unknown_id') {
    return {
      hadUuidPrefix: fields.hadUuidPrefix === true,
      ...(typeof fields.replyDecisionId === 'string' ? { replyDecisionId: fields.replyDecisionId } : {})
    }
  }
  if (event === 'authorization_revoked') {
    return {
      decisionId: fields.decisionId,
      ...(typeof fields.source === 'string' ? { source: fields.source } : {})
    }
  }
  return fields
}

function ownerMatchesIdentity(
  owner: RemoteArtifactDecisionOwner,
  identity: ArtifactDecisionInboundIdentity
): boolean {
  return (
    owner.source === identity.source &&
    owner.authOwner === identity.authOwner &&
    owner.privateChatTarget === identity.privateChatTarget
  )
}

async function replyAndAudit(
  replyText: (text: string) => void | Promise<void>,
  audit: (
    event: RemoteArtifactDecisionAuditEvent,
    fields: Record<string, unknown>
  ) => void | Promise<void>,
  event: RemoteArtifactDecisionAuditEvent,
  text: string,
  fields: Record<string, unknown>
): Promise<void> {
  // Protocol result must not depend on best-effort side effects. Audit failure must not
  // block the reply attempt; neither failure may prevent the caller from completing claim.
  try {
    await audit(event, safeAuditFields(event, fields))
  } catch {
    // swallow — decision/claim outcome is independent of audit I/O
  }
  try {
    await replyText(text)
  } catch {
    // swallow — platform reply is best-effort after the protocol result is known
  }
}

export async function handleArtifactDecisionInbound(input: {
  raw: string
  identity: ArtifactDecisionInboundIdentity
  authorizeBeforeSubmit: AuthorizeBeforeArtifactDecisionSubmit
  replyText: (text: string) => void | Promise<void>
  audit: (
    event: RemoteArtifactDecisionAuditEvent,
    fields: Record<string, unknown>
  ) => void | Promise<void>
}): Promise<ArtifactDecisionInboundResult> {
  const extracted = extractArtifactDecisionReplyPrefix(input.raw)
  const candidates = listArtifactDecisionCandidates(input.identity)

  if (extracted.hadUuidPrefix && extracted.replyDecisionId) {
    const matched = candidates.find((c) => c.owner.decisionId === extracted.replyDecisionId)
    if (!matched) {
      const tombstone = findArtifactDecisionTombstone(input.identity, extracted.replyDecisionId)
      if (tombstone) {
        await replyAndAudit(
          input.replyText,
          input.audit,
          'stale',
          '该决策已处理或已失效。',
          { decisionId: extracted.replyDecisionId }
        )
        return { handled: true, reason: 'stale' }
      }
      await replyAndAudit(
        input.replyText,
        input.audit,
        'unknown_id',
        '未找到对应的产物决策，请确认决策 ID 后重试。',
        { hadUuidPrefix: true, replyDecisionId: extracted.replyDecisionId }
      )
      return { handled: true, reason: 'unknown_decision_id' }
    }
    return settleSelectedCandidate(matched, extracted.body, true, input)
  }

  if (candidates.length === 0) {
    return { handled: false, reason: 'no_candidates' }
  }

  const bodyProbe = parseArtifactDecisionReplyBody(extracted.body, candidates[0]!.request.options, false)
  if (bodyProbe.kind === 'not_decision') {
    return { handled: false, reason: 'not_decision' }
  }

  if (candidates.length >= 2) {
    const lines = candidates.map(
      (c) => `${c.request.decisionId} 1`
    )
    await replyAndAudit(
      input.replyText,
      input.audit,
      'ambiguous',
      `当前有多条待决产物决策，请带决策 ID 回复，例如：\n${lines.join('\n')}`,
      { candidateCount: candidates.length }
    )
    return { handled: true, reason: 'ambiguous' }
  }

  return settleSelectedCandidate(candidates[0]!, extracted.body, false, input)
}

async function settleSelectedCandidate(
  candidate: ArtifactDecisionCandidate,
  body: string,
  hadUuidPrefix: boolean,
  input: {
    identity: ArtifactDecisionInboundIdentity
    authorizeBeforeSubmit: AuthorizeBeforeArtifactDecisionSubmit
    replyText: (text: string) => void | Promise<void>
    audit: (
      event: RemoteArtifactDecisionAuditEvent,
      fields: Record<string, unknown>
    ) => void | Promise<void>
  }
): Promise<ArtifactDecisionInboundResult> {
  if (!ownerMatchesIdentity(candidate.owner, input.identity)) {
    await replyAndAudit(
      input.replyText,
      input.audit,
      'binding_mismatch',
      '产物决策绑定不匹配，未提交。',
      { decisionId: candidate.request.decisionId }
    )
    return { handled: true, reason: 'binding_mismatch' }
  }

  const parsed = parseArtifactDecisionReplyBody(body, candidate.request.options, hadUuidPrefix)
  if (parsed.kind === 'not_decision') {
    return { handled: false, reason: 'not_decision' }
  }
  if (parsed.kind === 'usage_hint') {
    await replyAndAudit(
      input.replyText,
      input.audit,
      'hint',
      buildArtifactDecisionUsageHint(candidate.request.options),
      { decisionId: candidate.request.decisionId }
    )
    return { handled: true, reason: 'usage_hint' }
  }

  const choice = resolveRemoteArtifactDecisionChoice(candidate.request, {
    kind: 'choice',
    decisionId: candidate.request.decisionId,
    choice: parsed.choice
  })
  const payload = {
    decisionId: candidate.request.decisionId,
    requestId: candidate.request.requestId,
    sessionId: candidate.request.sessionId,
    toolUseId: candidate.request.toolUseId,
    attempt: candidate.request.attempt,
    choice
  }

  const authorization = input.authorizeBeforeSubmit()
  if (!authorization.ok) {
    await replyAndAudit(
      input.replyText,
      input.audit,
      'authorization_revoked',
      '当前远程授权已失效，未提交该产物决策。',
      { decisionId: candidate.request.decisionId, source: input.identity.source }
    )
    return { handled: true, reason: 'authorization_revoked' }
  }

  const submitResult = submitArtifactDecisionResponse(payload)
  if (submitResult === 'resolved') {
    await replyAndAudit(
      input.replyText,
      input.audit,
      'resolved',
      '已提交产物决策。',
      {
        decisionId: candidate.request.decisionId,
        choiceKey: choice.includes(':') ? choice.split(':')[0] : choice,
        hasInput: choice.includes(':')
      }
    )
    return { handled: true, reason: 'resolved' }
  }

  const messages: Record<'stale' | 'binding_mismatch' | 'invalid', string> = {
    stale: '该决策已处理或已失效。',
    binding_mismatch: '产物决策绑定不匹配，未提交。',
    invalid: '产物决策回复无效，未提交。'
  }
  await replyAndAudit(
    input.replyText,
    input.audit,
    submitResult,
    messages[submitResult],
    { decisionId: candidate.request.decisionId }
  )
  return { handled: true, reason: submitResult }
}
