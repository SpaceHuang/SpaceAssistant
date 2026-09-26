import { buildUserConfirmedReadExecutionPermit, readInputDigest, type ReadExecutionPermit } from './readExecutionPermit'
import { readConfirmationRegistry, type ReadConfirmationRegistry } from './readConfirmationRegistry'
import type { ReadPathFact } from './extractors/readPathFacts'
import type { FeishuMediaTargetFact } from './extractors/feishuMediaFacts'

export function settleReadConfirmation(input: { toolName: string; requestId: string; toolUseId: string; outcome: string }, registry: ReadConfirmationRegistry = readConfirmationRegistry): void {
  if (input.toolName !== 'read_file' && input.toolName !== 'grep' && input.toolName !== 'list_directory' && input.toolName !== 'read_feishu_attachment') return
  if (input.outcome === 'approved') return
  registry.settle(input.requestId, input.toolUseId, input.outcome === 'timeout' ? 'expired' : 'rejected')
}

export function finalizeReadConfirmation(input: { toolName: string; toolInput: Record<string, unknown>; requestId: string; toolUseId: string; outcome: string; answerer: string; readPathFact?: ReadPathFact; feishuMediaFact?: FeishuMediaTargetFact; approvedTargets?: Array<{ factId: string; decisionRuleId: string }> }, registry: ReadConfirmationRegistry = readConfirmationRegistry): ReadExecutionPermit | undefined {
  if ((input.toolName !== 'read_file' && input.toolName !== 'grep' && input.toolName !== 'list_directory' && input.toolName !== 'read_feishu_attachment') || input.outcome !== 'approved' || input.answerer !== 'user') return undefined
  const fact = input.toolName === 'read_feishu_attachment'
    ? input.feishuMediaFact?.boundary === 'inside' && input.feishuMediaFact.targetKind === 'file' && input.feishuMediaFact.normalizedPath && input.feishuMediaFact.identity
      ? { normalizedPath: input.feishuMediaFact.normalizedPath, zone: 'outside-workdir' as const, targetKind: 'file' as const, identity: input.feishuMediaFact.identity }
      : undefined
    : input.readPathFact
  if (!fact || (fact.targetKind === 'directory' && input.toolName !== 'list_directory') || (input.toolName === 'list_directory' && fact.targetKind !== 'directory' && !(fact.targetKind === 'symlink' && fact.resolvedKind === 'directory'))) return undefined
  const mapping = input.approvedTargets
  if (!mapping || mapping.length !== 1 || mapping[0]?.factId !== `fact-${fact.normalizedPath}` || !mapping[0]?.decisionRuleId) return undefined
  const target = { ...mapping[0], normalizedPath: fact.normalizedPath, zone: fact.zone, targetKind: input.toolName === 'list_directory' ? 'directory' as const : fact.targetKind, ...(input.toolName === 'list_directory' ? { scope: 'direct-entries' as const } : {}), ...(fact.identity ? { identity: fact.identity } : {}) }
  if (!registry.approve({ requestId: input.requestId, toolUseId: input.toolUseId, inputDigest: readInputDigest(input.toolInput), approvedFactIds: [target.factId], ruleId: target.decisionRuleId })) return undefined
  try { return buildUserConfirmedReadExecutionPermit({ requestId: input.requestId, toolUseId: input.toolUseId, toolName: input.toolName, input: input.toolInput, facts: [target] }, registry) } catch { return undefined }
}
