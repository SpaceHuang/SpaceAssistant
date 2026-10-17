import type { CapabilityRegistry } from './capability'
import type { PermitBinding, SafetyPermitStore } from './safetyPermit'

export type SafetyPolicyDecision =
  | { kind: 'allow'; authorizationVersion: string; expiresAt?: number }
  | { kind: 'ask'; confirmationId: string; answerer: 'user' | 'agent'; reasonCode: string; context?: unknown }
  | { kind: 'deny'; reasonCode: SafetyDenyReason; /** FR12②：模型可见的区分文案（经 ToolDeniedError.userMessage 以 is_error 工具结果回模型）；缺省走通用 fallback。 */ userMessage?: string }

export type SafetyDenyReason =
  | 'UNKNOWN_CAPABILITY' | 'UNAUTHORIZED_CAPABILITY' | 'MISSING_MATERIAL' | 'RULES_FLOOR_VIOLATED'
  | 'POLICY_DENY' | 'FACTS_CHANGED' | 'STALE_AUTHORIZATION' | 'SHELL_PRECHECK_DENY' | 'FILE_AUTO_APPROVAL_DENY'

export type SafetyPolicyPort = { evaluate(input: PermitBinding & { capability: ReturnType<CapabilityRegistry['lookup']>; signal?: AbortSignal }): Promise<SafetyPolicyDecision> }
export type SafetyPolicyResolver = (binding: PermitBinding) => SafetyPolicyPort
export type SafetyGateResult =
  | { kind: 'allow'; permitId: string; authorizationVersion: string; phase: PermitBinding['phase'] }
  | Extract<SafetyPolicyDecision, { kind: 'ask' }>
  | { kind: 'deny'; reasonCode: SafetyDenyReason }
export type SafetyEvaluation = SafetyPolicyDecision

/** Only this policy projection may issue a permit; execution handles remain behind host ports. */
export class SafetyGate {
  constructor(private readonly deps: { capabilities: CapabilityRegistry; permitStore: SafetyPermitStore; policy?: SafetyPolicyPort; resolvePolicy?: SafetyPolicyResolver }) {
    if (!deps.policy && !deps.resolvePolicy) throw new Error('safety policy is required')
  }

  async evaluate(binding: PermitBinding, signal?: AbortSignal): Promise<SafetyEvaluation> {
    if (signal?.aborted) return { kind: 'deny', reasonCode: 'POLICY_DENY' }
    const capability = this.deps.capabilities.lookup(binding.invocationId, binding.capabilityId)
    if (capability.state === 'unknown') return { kind: 'deny', reasonCode: 'UNKNOWN_CAPABILITY' }
    if (capability.state === 'known-unauthorized') return { kind: 'deny', reasonCode: 'UNAUTHORIZED_CAPABILITY' }
    const policy = this.deps.resolvePolicy?.(binding) ?? this.deps.policy!
    const decision = await policy.evaluate({ ...binding, capability, ...(signal ? { signal } : {}) })
    if (signal?.aborted) return { kind: 'deny', reasonCode: 'POLICY_DENY' }
    if (decision.kind !== 'allow') return decision
    if (decision.authorizationVersion !== binding.authorizationVersion) return { kind: 'deny', reasonCode: 'STALE_AUTHORIZATION' }
    return decision
  }

  private issuePermit(binding: PermitBinding, decision: SafetyEvaluation): SafetyGateResult {
    if (decision.kind !== 'allow') return decision
    if (decision.authorizationVersion !== binding.authorizationVersion) return { kind: 'deny', reasonCode: 'STALE_AUTHORIZATION' }
    const expiresAt = decision.expiresAt ?? Date.now() + 30_000
    try {
      const permitId = this.deps.permitStore.issue(binding, expiresAt)
      return { kind: 'allow', permitId, authorizationVersion: decision.authorizationVersion, phase: binding.phase }
    } catch {
      return { kind: 'deny', reasonCode: 'MISSING_MATERIAL' }
    }
  }

  /** Remove an issued permit that lost the race to cancellation before execution-port handoff. */
  discardPermit(permitId: string): void {
    this.deps.permitStore.settle(permitId)
  }

  async authorize(binding: PermitBinding, signal?: AbortSignal): Promise<SafetyGateResult> {
    return this.issuePermit(binding, await this.evaluate(binding, signal))
  }
}

/** SDK turn 循环实际消费的公开面（评审 P3）：宿主可显式委托包装，实例赋值仍然兼容。 */
export type SafetyGatePort = Pick<SafetyGate, 'evaluate' | 'authorize' | 'discardPermit'>
