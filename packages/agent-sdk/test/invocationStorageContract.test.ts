import { it } from 'vitest'
import type { AgentHostPorts } from '../src/invocation'
import type { HistoryPort } from '../src/history'
import type { ContextPort, ContextScope, ContextSnapshot, ContextCandidate, ContextCommitResult } from '../src/index'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
type HistoryPortIsUnified = Assert<Equal<NonNullable<AgentHostPorts['history']>, HistoryPort>>
type StorageBagIsRemoved = Assert<Equal<'storage' extends keyof AgentHostPorts ? true : false, false>>
type ContextPortExportIsPublic = Assert<Equal<ContextPort['readCurrent'], (scope: ContextScope) => Promise<ContextSnapshot>>>
type ContextCommitCandidateIsPublic = Assert<Equal<Parameters<ContextPort['commitReplacement']>[0]['candidate'], ContextCandidate>>
type ContextCommitResultIsPublic = Assert<Equal<Awaited<ReturnType<ContextPort['commitReplacement']>>, ContextCommitResult>>

it('uses the SDK HistoryPort directly and does not expose a generic storage bag', () => {
  const contractChecks: [HistoryPortIsUnified, StorageBagIsRemoved, ContextPortExportIsPublic, ContextCommitCandidateIsPublic, ContextCommitResultIsPublic] = [true, true, true, true, true]
  void contractChecks
})
