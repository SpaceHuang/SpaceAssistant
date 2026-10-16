import { createHash } from 'node:crypto'
import type { Decision, PolicyRule } from '../confirmation/types'

export type PolicyDomain = 'desktop' | 'im' | 'automation'

export interface DecisionTraceCause {
  readonly ruleId: string
  readonly relation: 'matched' | 'constraint' | 'fallback'
}

export interface PolicyDecision {
  readonly decisionId: string
  readonly invocationId: string
  readonly toolUseId: string
  readonly factsId: string
  readonly factsDigest: string
  readonly extractorVersion: string
  readonly factsRevision: number
  readonly policyDomain: PolicyDomain
  readonly tier: string
  readonly policyVersion: string
  readonly policyRevision: number
  readonly dependencyFingerprint: string
  /** 当前事实与最终决策实际依赖的有序规则子集。 */
  readonly dependencyRuleIds: readonly string[]
  readonly verdict: 'allow' | 'require-confirm' | 'deny'
  readonly ruleIds: readonly string[]
  readonly causes: readonly DecisionTraceCause[]
  readonly answerer?: 'user' | 'agent'
  readonly reasonCode: string
  readonly agentResultRef?: string
}

export interface PolicyDependencyInput {
  policyLane: string
  policyVersion: string
  policyRevision: number
  tier: string
  rules: readonly PolicyRule[]
  disabledRuleIds: readonly string[]
  policyConfig: Readonly<Record<string, unknown>>
  migrationComplete: boolean
}

export function selectPolicyDependencyRules(input: {
  rules: readonly PolicyRule[]
  matchingRuleIds: readonly string[]
  decisionRuleIds: readonly string[]
}): readonly PolicyRule[] {
  const matching = new Set(input.matchingRuleIds)
  const decision = new Set(input.decisionRuleIds)
  const selected: PolicyRule[] = []
  let reachedDecision = false
  for (const rule of input.rules) {
    const protective = rule.action === 'deny' || rule.humanRequired === true || rule.action === 'confirm-every-time'
    if (matching.has(rule.id) && (!reachedDecision || protective)) selected.push(rule)
    if (decision.has(rule.id)) reachedDecision = true
  }
  // Synthetic validator/cache/fallback decisions have no corresponding policy rule.
  if (selected.length === 0 || !selected.some((rule) => decision.has(rule.id))) {
    for (const rule of input.rules) if (matching.has(rule.id) && !selected.includes(rule)) selected.push(rule)
  }
  return selected
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
  }
  throw new Error('POLICY_DEPENDENCY_NON_JSON')
}

export function fingerprintPolicyDependencies(input: PolicyDependencyInput): string {
  if (!input.policyVersion.trim() || !input.tier.trim() || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 0) {
    throw new Error('POLICY_DEPENDENCY_VERSION_INVALID')
  }
  const projection = {
    policyVersion: input.policyVersion,
    policyRevision: input.policyRevision,
    tier: input.tier,
    policyLane: input.policyLane,
    policyConfig: input.policyConfig,
    migrationComplete: input.migrationComplete,
    // Preserve order because matching and layered resolution depend on it.
    rules: input.rules.map((rule) => ({
      id: rule.id, when: rule.when, match: rule.match, action: rule.action, userOverride: rule.userOverride,
      humanRequired: rule.humanRequired, answerer: rule.answerer, locked: rule.locked, denyClass: rule.denyClass, reason: rule.reason,
      askUnless: rule.askUnless, configRequires: rule.configRequires, requiresContext: rule.requiresContext
    })),
    disabledRuleIds: [...input.disabledRuleIds].sort()
  }
  return `sha256:${createHash('sha256').update(stableSerialize(projection)).digest('hex')}`
}

export function createPolicyDecision(input: {
  decision: Decision
  invocationId: string
  toolUseId: string
  factsId: string
  factsDigest: string
  extractorVersion: string
  factsRevision: number
  policyDomain: PolicyDomain
  tier: string
  policyVersion: string
  policyRevision: number
  policyLane: string
  rules: readonly PolicyRule[]
  dependencyRules?: readonly PolicyRule[]
  disabledRuleIds: readonly string[]
  policyConfig: Readonly<Record<string, unknown>>
  migrationComplete: boolean
  agentResultRef?: string
}): PolicyDecision {
  if (![input.invocationId, input.toolUseId, input.factsId, input.factsDigest, input.extractorVersion].every((value) => value.trim())) {
    throw new Error('POLICY_DECISION_BINDING_REQUIRED')
  }
  const decision = input.decision
  const verdict = decision.type === 'auto-allow' ? 'allow' : decision.type
  const relation = decision.ruleId.startsWith('default-') ? 'fallback' : 'matched'
  const causes: DecisionTraceCause[] = [{ ruleId: decision.ruleId, relation }]
  if (decision.cause && decision.cause !== decision.ruleId) causes.push({ ruleId: decision.cause, relation: 'constraint' })
  const ruleIds = [...new Set(causes.map((cause) => cause.ruleId))]
  const dependencyRules = input.dependencyRules ?? input.rules
  const dependencyFingerprint = fingerprintPolicyDependencies({ ...input, rules: dependencyRules })
  const decisionId = `decision-${createHash('sha256').update(stableSerialize({ invocationId: input.invocationId,
    toolUseId: input.toolUseId, factsId: input.factsId, factsDigest: input.factsDigest,
    extractorVersion: input.extractorVersion, factsRevision: input.factsRevision,
    dependencyFingerprint, verdict, ruleIds,
    answerer: decision.type === 'require-confirm' ? decision.answerer : undefined,
    agentResultRef: input.agentResultRef })).digest('hex').slice(0, 24)}`
  return Object.freeze({
    decisionId,
    invocationId: input.invocationId,
    toolUseId: input.toolUseId,
    factsId: input.factsId,
    factsDigest: input.factsDigest,
    extractorVersion: input.extractorVersion,
    factsRevision: input.factsRevision,
    policyDomain: input.policyDomain,
    tier: input.tier,
    policyVersion: input.policyVersion,
    policyRevision: input.policyRevision,
    dependencyFingerprint,
    dependencyRuleIds: Object.freeze(dependencyRules.map((rule) => rule.id)),
    verdict,
    ruleIds: Object.freeze(ruleIds),
    causes: Object.freeze(causes.map((cause) => Object.freeze(cause))),
    ...(decision.type === 'require-confirm' ? { answerer: decision.answerer } : {}),
    reasonCode: decision.ruleId,
    ...(input.agentResultRef ? { agentResultRef: input.agentResultRef } : {})
  })
}
