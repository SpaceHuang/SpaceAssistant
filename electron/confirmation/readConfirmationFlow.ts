import { buildReadExecutionPermit, buildUserConfirmedReadExecutionPermit, readInputDigest, type ReadExecutionPermit } from './readExecutionPermit'
import { readConfirmationRegistry, type ReadConfirmationRegistry } from './readConfirmationRegistry'
import type { ReadPathFact } from './extractors/readPathFacts'
import type { FeishuMediaTargetFact } from './extractors/feishuMediaFacts'
import { extractPathField } from '../toolPathField'
import { DEFAULT_USER_CONFIRMATION_TIMEOUT_MS } from './confirmationTimeout'

export function settleReadConfirmation(input: { toolName: string; requestId: string; toolUseId: string; outcome: string }, registry: ReadConfirmationRegistry = readConfirmationRegistry): void {
  if (input.toolName !== 'read_file' && input.toolName !== 'grep' && input.toolName !== 'list_directory' && input.toolName !== 'read_feishu_attachment') return
  if (input.outcome === 'approved') return
  registry.settle(input.requestId, input.toolUseId, input.outcome === 'timeout' ? 'expired' : 'rejected')
}

/** Register the exact fresh target when a previously approved read is escalated to human review. */
export function registerReadReapproval(input: { toolName: string; toolInput: Record<string, unknown>; requestId: string; toolUseId: string; readPathFact?: ReadPathFact; approvedTargets?: Array<{ factId: string; decisionRuleId: string }>; timeoutMs?: number }, registry: ReadConfirmationRegistry = readConfirmationRegistry): boolean {
  if (!['read_file', 'grep', 'list_directory'].includes(input.toolName) || input.readPathFact?.zone !== 'outside-workdir' || !input.readPathFact.identity) return false
  const factId = `fact-${input.readPathFact.normalizedPath}`
  const mapping = input.approvedTargets
  if (!mapping || mapping.length !== 1 || mapping[0]?.factId !== factId || !mapping[0]?.decisionRuleId) return false
  const registration = {
    requestId: input.requestId,
    toolUseId: input.toolUseId,
    inputDigest: readInputDigest(input.toolInput),
    factIds: [factId],
    ruleId: mapping[0].decisionRuleId,
    expiresAt: Date.now() + (input.timeoutMs ?? DEFAULT_USER_CONFIRMATION_TIMEOUT_MS)
  }
  return registry.register(registration) || registry.matchesPending(registration) || registry.refreshPending(registration)
}

export function finalizeReadConfirmation(input: { toolName: string; toolInput: Record<string, unknown>; requestId: string; toolUseId: string; outcome: string; answerer: string; readPathFact?: ReadPathFact; feishuMediaFact?: FeishuMediaTargetFact; approvedTargets?: Array<{ factId: string; decisionRuleId: string }> }, registry: ReadConfirmationRegistry = readConfirmationRegistry): ReadExecutionPermit | undefined {
  if ((input.toolName !== 'read_file' && input.toolName !== 'grep' && input.toolName !== 'list_directory' && input.toolName !== 'read_feishu_attachment') || input.outcome !== 'approved' || input.answerer !== 'user') return undefined
  const fact = input.toolName === 'read_feishu_attachment'
    ? input.feishuMediaFact?.boundary === 'inside' && input.feishuMediaFact.targetKind === 'file' && input.feishuMediaFact.normalizedPath && input.feishuMediaFact.identity
      ? { normalizedPath: input.feishuMediaFact.normalizedPath, zone: 'outside-workdir' as const, targetKind: 'file' as const, identity: input.feishuMediaFact.identity }
      : undefined
    : input.readPathFact
  if (!fact) return undefined
  // 目录目标：list_directory（direct-entries）与 grep（subtree）均可经确认兑现；
  // grep 目录允许 symlink→directory 归一（与 gate auto-allow 路径同口径）。
  // read_file 显式拒绝目录/symlink→directory（N8：纵深一层，executor 侧 targetKind 拒绝为兜底）。
  const isResolvedDirectory = fact.targetKind === 'directory' || (fact.targetKind === 'symlink' && fact.resolvedKind === 'directory')
  const isResolvedFile = fact.targetKind === 'file' || (fact.targetKind === 'symlink' && fact.resolvedKind === 'file')
  if (input.toolName === 'read_file' && isResolvedDirectory) return undefined
  if (input.toolName === 'list_directory' && !isResolvedDirectory) return undefined
  if (input.toolName === 'grep' && !(isResolvedDirectory || isResolvedFile || fact.targetKind === 'missing')) return undefined
  const mapping = input.approvedTargets
  if (!mapping || mapping.length !== 1 || mapping[0]?.factId !== `fact-${fact.normalizedPath}` || !mapping[0]?.decisionRuleId) return undefined
  const target = { ...mapping[0], normalizedPath: fact.normalizedPath, zone: fact.zone, targetKind: input.toolName === 'list_directory' || (input.toolName === 'grep' && isResolvedDirectory) ? 'directory' as const : fact.targetKind, ...(input.toolName === 'list_directory' ? { scope: 'direct-entries' as const } : {}), ...(input.toolName === 'grep' && isResolvedDirectory ? { scope: 'subtree' as const } : {}), ...(fact.identity ? { identity: fact.identity } : {}) }
  if (!registry.approve({ requestId: input.requestId, toolUseId: input.toolUseId, inputDigest: readInputDigest(input.toolInput), approvedFactIds: [target.factId], ruleId: target.decisionRuleId })) return undefined
  try { return buildUserConfirmedReadExecutionPermit({ requestId: input.requestId, toolUseId: input.toolUseId, toolName: input.toolName, input: input.toolInput, facts: [target] }, registry) } catch { return undefined }
}

/** Create a call-bound permit only after the safety Agent approved a complete ordinary read fact. */
export function finalizeAgentReadReview(input: { toolName: string; toolInput: Record<string, unknown>; requestId: string; toolUseId: string; outcome: string; answerer: string; readPathFact?: ReadPathFact; approvedTargets?: Array<{ factId: string; decisionRuleId: string }>; decisionId?: string; policyDependencyFingerprint?: string }): ReadExecutionPermit | undefined {
  if (input.answerer !== 'agent' || input.outcome !== 'approved' || !input.readPathFact) return undefined
  const fact = input.readPathFact
  if (fact.zone !== 'outside-workdir' || !fact.identity || !['read_file', 'grep', 'list_directory'].includes(input.toolName)) return undefined
  const requestedPath = extractPathField(input.toolInput) ?? (input.toolName === 'grep' || input.toolName === 'list_directory' ? '.' : undefined)
  if (requestedPath !== fact.rawPath) return undefined
  const isDirectory = fact.targetKind === 'directory' && fact.resolvedKind !== 'special'
  const isSingleFile = fact.targetKind === 'file' && (input.toolName === 'read_file' || input.toolName === 'grep')
  const isDirectListing = input.toolName === 'list_directory' && isDirectory && fact.scope === 'direct-entries-snapshot'
  if (!isSingleFile && !isDirectListing) return undefined
  const mapping = input.approvedTargets
  if (!mapping || mapping.length !== 1 || mapping[0]?.factId !== `fact-${fact.normalizedPath}` || !mapping[0]?.decisionRuleId) return undefined
  return buildReadExecutionPermit({
    requestId: input.requestId,
    toolUseId: input.toolUseId,
    toolName: input.toolName as 'read_file' | 'grep' | 'list_directory',
    input: input.toolInput,
    decisionId: input.decisionId,
    policyDependencyFingerprint: input.policyDependencyFingerprint,
    facts: [{ ...mapping[0], normalizedPath: fact.normalizedPath, zone: fact.zone, targetKind: isDirectListing ? 'directory' : 'file', ...(isDirectListing ? { scope: 'direct-entries' as const } : {}), identity: fact.identity }]
  })
}
