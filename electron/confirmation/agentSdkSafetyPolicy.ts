import { createHash } from 'node:crypto'
import type { SafetyDenyReason, SafetyPolicyPort } from '../../packages/agent-sdk/src/safetyGate'
import type { CapabilityLookup } from '../../packages/agent-sdk/src/capability'
import type { PermitBinding } from '../../packages/agent-sdk/src/safetyPermit'
import { isSafetyRecheckAllowed } from './safetyRecheck'
import { buildToolCallGateArgs, evaluateToolCallGate, type ToolCallGateArgs, type ToolCallGateResult } from './toolCallGate'
import { finalizeReadConfirmation } from './readConfirmationFlow'
import { buildWriteExecutionPermit } from './writeExecutionPermit'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'

export type AgentSdkGateArgsResolver = (binding: PermitBinding, call?: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }>, signal?: AbortSignal) => Promise<ToolCallGateArgs>
export type AgentSdkGateEvaluator = (args: ToolCallGateArgs) => Promise<ToolCallGateResult>

/** Thin adapter: all host facts and policy decisions remain owned by the existing toolCallGate. */
export function createAgentSdkSafetyPolicy(input: {
  resolveGateArgs: AgentSdkGateArgsResolver
  resolveToolCall?(binding: PermitBinding): Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }> | undefined
  getPreparedFacts?(identity: Pick<PermitBinding, 'invocationId' | 'toolCallId'>): unknown
  evaluateGate?: AgentSdkGateEvaluator
  resolveToolName?(providerToolName: string): string
  /** Attach structural read/write permits from the initial host gate to the call-private execution context. */
  onInitialGateResult?(binding: PermitBinding, result: ToolCallGateResult, args: ToolCallGateArgs): void | Promise<void>
  /** Finalize user-approved structural permits after the existing confirmation channel approves. */
  onConfirmed?(binding: PermitBinding, result: ToolCallGateResult, args: ToolCallGateArgs, answerer: 'user' | 'agent', memory?: import('../../src/shared/confirmation/types').CacheKey): void
}): SafetyPolicyPort & { markConfirmed(call: Pick<PermitBinding, 'invocationId' | 'toolCallId'>, answerer?: 'user' | 'agent', memory?: import('../../src/shared/confirmation/types').CacheKey): void } {
  const initial = new Map<string, { binding: PermitBinding; result: ToolCallGateResult; args: ToolCallGateArgs; confirmed: boolean; confirmedAnswerer?: 'user' | 'agent' }>()
  const callKey = (binding: PermitBinding) => JSON.stringify([binding.invocationId, binding.toolCallId])
  const deny = (binding: PermitBinding, reasonCode: SafetyDenyReason) => {
    if (binding.phase === 'recheck') initial.delete(callKey(binding))
    return { kind: 'deny' as const, reasonCode }
  }
  const ask = (binding: PermitBinding, result: ToolCallGateResult, args: ToolCallGateArgs) => {
    const decision = result.decision
    if (decision.type !== 'require-confirm') return deny(binding, 'POLICY_DENY')
    return {
      kind: 'ask' as const, confirmationId: binding.toolCallId, answerer: decision.answerer, reasonCode: decision.ruleId,
      context: {
        toolName: args.toolName,
        ...(args.toolName === 'run_shell' && typeof args.toolInput.justification === 'string'
          ? { modelJustification: args.toolInput.justification }
          : {}),
        ...(args.toolName === 'run_shell' && args.toolInput._justificationTruncated === true
          ? { modelJustificationTruncated: true }
          : {}),
        ...(args.lane ? { lane: args.lane } : {}),
        ...(args.currentPageUrl ? { currentPageUrl: args.currentPageUrl } : {}),
        ...(args.dangerAssessment ? { dangerAssessment: args.dangerAssessment } : {}),
        ...(args.remoteBudgetState ? { remoteBudgetState: args.remoteBudgetState } : {}),
        decision: { riskLevel: decision.riskLevel, memoryTiers: decision.memoryTiers, timeoutMs: decision.timeoutMs,
          answerer: decision.answerer, disposition: decision.disposition },
        facts: result.facts,
        ...(result.factsSnapshot ? { factsProvenance: { factId: result.factsSnapshot.factId, extractorVersion: result.factsSnapshot.extractorVersion, completeness: result.factsSnapshot.completeness, factsRevision: result.factsSnapshot.factsRevision, policyVersion: result.factsSnapshot.policyVersion } } : {}),
        approvedFactIds: result.approvedFactIds,
        ...(result.readTargetMapping ? { readTargetMapping: result.readTargetMapping } : {}),
        ...(result.readPathFact ? { readPathFact: result.readPathFact } : {}),
        ...(result.readExecutionPermit ? { readExecutionPermit: result.readExecutionPermit } : {}),
        ...(result.writePathFact ? { writePathFact: result.writePathFact } : {}),
        ...(result.writeExecutionPermit ? { writeExecutionPermit: result.writeExecutionPermit } : {}),
        ...(result.reviewScopeCandidate ? { reviewScopeCandidate: result.reviewScopeCandidate } : {}),
        ...(result.shellPrecheck ? { shellPrecheck: result.shellPrecheck } : {}),
        ...(result.autoApproveFallback ? { autoApproveFallback: result.autoApproveFallback } : {}),
        ...(result.mcpEntry ? { mcpEntry: result.mcpEntry } : {}),
        ...(result.scriptPathHint ? { scriptPathHint: result.scriptPathHint } : {})
      }
    }
  }
  return {
    markConfirmed(call: Pick<PermitBinding, 'invocationId' | 'toolCallId'>, answerer: 'user' | 'agent' = 'user', memory?: import('../../src/shared/confirmation/types').CacheKey) {
      const decision = initial.get(JSON.stringify([call.invocationId, call.toolCallId]))
      if (decision) {
        input.onConfirmed?.(decision.binding, decision.result, decision.args, answerer, memory)
        decision.confirmed = true
        decision.confirmedAnswerer = answerer
      }
    },
    async evaluate(binding) {
      const key = callKey(binding)
      const previous = binding.phase === 'recheck' ? initial.get(key) : undefined
      if (binding.phase === 'recheck') {
        if (!previous && !binding.policyChanged) return { kind: 'deny', reasonCode: 'MISSING_MATERIAL' }
        // Claim the prior decision before asynchronous work; a policyChanged recheck
        // without a prior baseline instead performs a completely fresh gate pass.
        if (previous) initial.delete(key)
      }
      try {
        const call = input.resolveToolCall?.(binding)
        const preparedCapabilityId = call ? (input.resolveToolName?.(call.toolName) ?? call.toolName) : undefined
        const boundCapabilityId = input.resolveToolName?.(binding.capabilityId) ?? binding.capabilityId
        if (input.resolveToolCall && (!call || call.invocationId !== binding.invocationId || call.toolCallId !== binding.toolCallId || preparedCapabilityId !== boundCapabilityId)) {
          return deny(binding, 'MISSING_MATERIAL')
        }
        const args = await input.resolveGateArgs(binding, call, binding.signal)
        if (binding.signal?.aborted) return deny(binding, 'POLICY_DENY')
        if (call && (call.toolName === 'wechat_send' || call.toolName === 'wechat_reply' || call.toolName === 'run_lark_cli')) {
          const prepared = input.getPreparedFacts?.(call)
          const projection = prepared && typeof prepared === 'object' ? (prepared as { outboundPolicyFacts?: unknown }).outboundPolicyFacts : undefined
          const facts = Array.isArray(projection) ? projection as import('../../src/shared/confirmation/types').FactSignal[] : []
          args.factsProvider = () => facts
        }
        const resolvedInputHash = createHash('sha256').update(stableSerialize(args.toolInput)).digest('hex')
        if (resolvedInputHash !== binding.inputSnapshotHash) return deny(binding, 'STALE_AUTHORIZATION')
        const gateArgs = buildToolCallGateArgs(args, {
          toolName: input.resolveToolName?.(authorizedCapabilityId(binding.capability)) ?? authorizedCapabilityId(binding.capability),
          toolInput: args.toolInput,
          requestId: binding.requestId,
          toolUseId: binding.toolCallId,
          phase: binding.phase === 'recheck' ? 'recheck' : 'initial',
          ...(previous?.confirmed ? { previouslyConfirmed: true } : {}),
          ...(binding.phase === 'recheck' ? { evaluateFastTrackOnRecheck: true } : {})
        })
        const result = await (input.evaluateGate ?? evaluateToolCallGate)(gateArgs)
        if (binding.signal?.aborted) return deny(binding, 'POLICY_DENY')
        const decision = result.decision
        if (binding.phase === 'recheck') {
          if (!previous) {
            if (!binding.policyChanged) return deny(binding, 'MISSING_MATERIAL')
            await input.onInitialGateResult?.(structuredClone(binding), structuredClone(result), gateArgs)
            if (decision.type === 'auto-allow') return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
            if (decision.type === 'require-confirm') {
              initial.set(key, { binding: structuredClone(binding), result: structuredClone(result), args: gateArgs, confirmed: false })
              return ask(binding, result, gateArgs)
            }
            return { kind: 'deny', reasonCode: 'POLICY_DENY' }
          }
          const sameFacts = createHash('sha256').update(JSON.stringify(previous.result.facts)).digest('hex') === createHash('sha256').update(JSON.stringify(result.facts)).digest('hex')
          const samePolicyDependencies = previous.result.policyDecision && result.policyDecision
            ? previous.result.policyDecision.dependencyFingerprint === result.policyDecision.dependencyFingerprint
            : previous.binding.authorizationVersion === binding.authorizationVersion
          const sameWriteTarget = sameWritePathTarget(previous.result.writePathFact, result.writePathFact)
          const sameReadTarget = stableSerialize(previous.result.readPathFact) === stableSerialize(result.readPathFact)
          const sameFeishuMediaTarget = stableSerialize(previous.result.feishuMediaFact) === stableSerialize(result.feishuMediaFact)
          const sameScriptApprovalBinding = matchesScriptApprovalBinding(previous.result, result)
          const sameWriteApprovalConfiguration = previous.result.facts.actionClass !== 'write' ||
            writeApprovalConfigurationSnapshot(previous.args) === writeApprovalConfigurationSnapshot(gateArgs)
          const sameConfirmedDecisionRule = decision.ruleId === previous.result.decision.ruleId ||
            (decision.type === 'auto-allow' && decision.ruleId === 'cache-hit' && previous.result.decision.type === 'require-confirm')
          const sameConfirmedDecision = previous.confirmed &&
            (decision.type === 'auto-allow' || decision.type === 'require-confirm') &&
            sameConfirmedDecisionRule && sameFacts
          const sameExecutionMaterials = sameFacts && sameWriteTarget && sameReadTarget && sameFeishuMediaTarget &&
            sameScriptApprovalBinding && sameWriteApprovalConfiguration
          if (!samePolicyDependencies && sameExecutionMaterials) {
            // A policy revision changes the decision authority, even when host facts and
            // execution targets are identical. Apply the new action now; never carry the
            // old confirmation across the changed dependency fingerprint.
            initial.delete(key)
            if (decision.type === 'auto-allow') {
              await input.onInitialGateResult?.(structuredClone(binding), structuredClone(result), gateArgs)
              // Keep a fresh, unconfirmed baseline for the SDK's final authorization
              // after prepare/replan. It carries no prior receipt or approval.
              initial.set(key, { binding: structuredClone(binding), result: structuredClone(result), args: gateArgs, confirmed: false })
              return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
            }
            if (decision.type === 'require-confirm') {
              initial.set(key, { binding: structuredClone(binding), result: structuredClone(result), args: gateArgs, confirmed: false })
              return ask(binding, result, gateArgs)
            }
            return { kind: 'deny', reasonCode: 'POLICY_DENY' }
          }
          const recheckAllowed = samePolicyDependencies && sameWriteTarget && sameReadTarget && sameFeishuMediaTarget && sameScriptApprovalBinding && sameWriteApprovalConfiguration &&
            (previous.confirmed ? sameConfirmedDecision : decision.type === 'auto-allow')
          initial.delete(key)
          if (!recheckAllowed) {
            const confirmationScopeChanged = previous.confirmed && (
              !sameFacts || !sameWriteTarget || !sameReadTarget || !sameFeishuMediaTarget || !sameScriptApprovalBinding ||
              !sameWriteApprovalConfiguration || !sameConfirmedDecision
            )
            const humanBottomLine = decision.type === 'require-confirm' && (
              decision.answerer === 'user' && decision.disposition === 'human-required' ||
              previous.confirmedAnswerer === 'agent' && decision.answerer === 'agent' && decision.disposition === 'auto-eligible'
            )
            if (confirmationScopeChanged && humanBottomLine) {
              // The previous receipt no longer covers the latest facts. Preserve only the fresh
              // decision so the confirmation port can create a new, precisely bound human todo.
              // A changed target/risk cannot be re-approved by reusing the prior Agent verdict.
              // A second recheck is required after that new decision is approved.
              const humanResult = decision.answerer === 'user' && decision.disposition === 'human-required'
                ? result
                : { ...result, decision: { ...decision, answerer: 'user' as const, disposition: 'human-required' as const } }
              initial.set(key, { binding: structuredClone(binding), result: structuredClone(humanResult), args: gateArgs, confirmed: false })
              return ask(binding, humanResult, gateArgs)
            }
            return { kind: 'deny', reasonCode: confirmationScopeChanged ? 'FACTS_CHANGED' : 'POLICY_DENY' }
          }
          return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
        }
        await input.onInitialGateResult?.(structuredClone(binding), structuredClone(result), gateArgs)
        if (decision.type === 'auto-allow') {
          initial.set(key, { binding: structuredClone(binding), result: structuredClone(result), args: gateArgs, confirmed: false })
          return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
        }
        if (decision.type === 'require-confirm') {
          initial.set(key, { binding: structuredClone(binding), result: structuredClone(result), args: gateArgs, confirmed: false })
          return ask(binding, result, gateArgs)
        }
        initial.delete(key)
        return { kind: 'deny', reasonCode: 'POLICY_DENY' }
      } catch {
        return { kind: 'deny', reasonCode: 'MISSING_MATERIAL' }
      }
    }
  }
}

/** Moves existing gate-issued path permits into the exact Hosted RegisteredTool call context. */
export function createAgentSdkStructuralPermitHandoff(input: {
  updateExecutionContext(call: { invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }, update: (context: Record<string, unknown>) => void): void
  readConfirmationRegistry?: import('./readConfirmationRegistry').ReadConfirmationRegistry
}): Pick<NonNullable<Parameters<typeof createAgentSdkSafetyPolicy>[0]>, 'onInitialGateResult' | 'onConfirmed'> {
  return {
    onInitialGateResult(binding, result, args) {
      if (result.readExecutionPermit) {
        input.updateExecutionContext({ invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: args.toolName, input: args.toolInput }, (context) => {
          context.readExecutionPermit = result.readExecutionPermit
        })
      }
      if (result.writePathFact && result.decision.type === 'auto-allow') {
        const permit = buildWriteExecutionPermit({
          requestId: binding.requestId,
          toolUseId: binding.toolCallId,
          toolName: args.toolName as 'write_file' | 'edit_file',
          input: args.toolInput,
          target: result.writePathFact,
          decisionRuleId: result.decision.ruleId,
          approval: result.decision.ruleId === 'automation-bound-output-write-allow' || result.fileAutoApproved ? 'auto-allow' : 'confirmed',
          lane: result.lane,
          ...(result.automationOutputBinding ? { automationOutputBinding: result.automationOutputBinding } : {}),
          ...(result.automationOutputScope ? { automationOutputScope: result.automationOutputScope } : {}),
          ...(result.policyDecision ? { decisionId: result.policyDecision.decisionId, policyDependencyFingerprint: result.policyDecision.dependencyFingerprint } : {})
        })
        input.updateExecutionContext({ invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: args.toolName, input: args.toolInput }, (context) => {
          context.writeExecutionPermit = permit
        })
      }
    },
    onConfirmed(binding, result, args, answerer = 'user') {
      const call = { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: args.toolName, input: args.toolInput }
      if (result.decision.type !== 'require-confirm') return
      const readPermit = finalizeReadConfirmation({
        toolName: args.toolName,
        toolInput: args.toolInput,
        requestId: binding.requestId,
        toolUseId: binding.toolCallId,
        outcome: 'approved',
        answerer,
        readPathFact: result.readPathFact,
        feishuMediaFact: result.feishuMediaFact,
        approvedTargets: result.readTargetMapping
      }, input.readConfirmationRegistry)
      if (readPermit) input.updateExecutionContext(call, (context) => { context.readExecutionPermit = readPermit })
      if (result.writePathFact) {
        const writePermit = buildWriteExecutionPermit({
          requestId: binding.requestId,
          toolUseId: binding.toolCallId,
          toolName: args.toolName as 'write_file' | 'edit_file',
          input: args.toolInput,
          target: result.writePathFact,
          decisionRuleId: result.decision.ruleId,
          approval: result.decision.ruleId === 'automation-bound-output-write-allow' || result.fileAutoApproved ? 'auto-allow' : 'confirmed',
          lane: result.lane,
          ...(result.automationOutputBinding ? { automationOutputBinding: result.automationOutputBinding } : {}),
          ...(result.automationOutputScope ? { automationOutputScope: result.automationOutputScope } : {}),
          ...(result.policyDecision ? { decisionId: result.policyDecision.decisionId, policyDependencyFingerprint: result.policyDecision.dependencyFingerprint } : {})
        })
        input.updateExecutionContext(call, (context) => { context.writeExecutionPermit = writePermit })
      }
    }
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(',')}}`
}

/** final-check: an approved run_script call is bound to its host-computed code, parameter and environment digests. */
function matchesScriptApprovalBinding(previous: ToolCallGateResult, current: ToolCallGateResult): boolean {
  if (previous.facts.toolName !== 'run_script' && current.facts.toolName !== 'run_script') return true
  if (previous.facts.toolName !== 'run_script' || current.facts.toolName !== 'run_script') return false
  const binding = (result: ToolCallGateResult) => result.facts.signals.find((signal) => signal.kind === 'script-path-extraction')
  const prior = binding(previous)
  const latest = binding(current)
  return prior?.kind === 'script-path-extraction' && latest?.kind === 'script-path-extraction'
    && Boolean(prior.contentDigest && prior.parametersDigest && prior.environmentDigest)
    && prior.contentDigest === latest.contentDigest
    && prior.parametersDigest === latest.parametersDigest
    && prior.environmentDigest === latest.environmentDigest
    && prior.authenticationVersion === latest.authenticationVersion
}

/**
 * Bind approval to the exact target and parent directory object, permissions, and target identity.
 * Directory size, mtime, and link count describe sibling entries; unrelated writes in the same
 * directory must not invalidate an edit that still targets the same unchanged file.
 */
function sameWritePathTarget(
  previous: ToolCallGateResult['writePathFact'],
  current: ToolCallGateResult['writePathFact']
): boolean {
  if (!previous || !current) return previous === current
  const stableTarget = (fact: NonNullable<ToolCallGateResult['writePathFact']>) => ({
    ...fact,
    parentIdentity: {
      dev: fact.parentIdentity.dev,
      ino: fact.parentIdentity.ino,
      mode: fact.parentIdentity.mode
    }
  })
  return stableSerialize(stableTarget(previous)) === stableSerialize(stableTarget(current))
}

/** File-write approval is tied to the threshold and sensitive-path configuration shown at approval time. */
function writeApprovalConfigurationSnapshot(args: ToolCallGateArgs): string {
  return stableSerialize({
    workDir: args.workDir,
    userDataDir: args.userDataDir,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, ...args.toolsConfig },
    shellConfig: args.shellConfig ?? null,
    wikiConfig: args.wikiConfig ?? null
  })
}

/** Mark the exact initial decision as user/agent approved before a later fresh policy recheck. */
export function markAgentSdkSafetyDecisionConfirmed(policy: SafetyPolicyPort, call: Pick<PermitBinding, 'invocationId' | 'toolCallId'>, answerer: 'user' | 'agent' = 'user', memory?: import('../../src/shared/confirmation/types').CacheKey): void {
  // Confirmation state is deliberately owned by the policy instance; only the dedicated wrapper exposes this transition.
  const transition = policy as SafetyPolicyPort & { markConfirmed?: (call: Pick<PermitBinding, 'invocationId' | 'toolCallId'>, answerer?: 'user' | 'agent', memory?: import('../../src/shared/confirmation/types').CacheKey) => void }
  if (memory === undefined) transition.markConfirmed?.(call, answerer)
  else transition.markConfirmed?.(call, answerer, memory)
}

function authorizedCapabilityId(capability: CapabilityLookup): string {
  if (capability.state !== 'known-authorized') throw new Error('capability must be authorized before gate evaluation')
  return capability.id
}

/** Projects one already-computed host recheck into the SDK permit decision without evaluating host policy twice. */
export function createSafetyPolicyFromRecheck(resolve: () => Promise<{
  allowed: boolean
  authorizationVersion: string
} | undefined> | undefined): SafetyPolicyPort {
  return {
    async evaluate() {
      try {
        const decision = await resolve()
        if (!decision?.allowed || !decision.authorizationVersion.trim()) return { kind: 'deny', reasonCode: 'POLICY_DENY' }
        return { kind: 'allow', authorizationVersion: decision.authorizationVersion }
      } catch {
        return { kind: 'deny', reasonCode: 'MISSING_MATERIAL' }
      }
    }
  }
}

/** Couples one fresh host gate evaluation to both coordinator dispatch and the SDK SafetyPolicy. */
export function createAgentSdkRecheckPort(input: {
  initialRuleId: string
  initialFacts: unknown
  previouslyConfirmed: boolean
  resolveAuthorizationVersion(): string | undefined
  isRevoked(): boolean
  evaluate(): Promise<ToolCallGateResult>
}): {
  recheck(): Promise<{ allowed: boolean; authorizationVersion: string; targetVersion: string; factsHash: string }>
  safetyPolicy: SafetyPolicyPort
} {
  const initialFactsHash = createHash('sha256').update(JSON.stringify(input.initialFacts)).digest('hex')
  const initialAuthorizationEpoch = input.resolveAuthorizationVersion()
  let latest: { allowed: boolean; authorizationVersion: string; targetVersion: string; factsHash: string } | undefined
  return {
    async recheck() {
      latest = undefined
      const result = await input.evaluate()
      const factsHash = createHash('sha256').update(JSON.stringify(result.facts)).digest('hex')
      latest = {
        allowed: isSafetyRecheckAllowed({
          initialRuleId: input.initialRuleId,
          initialFactsHash,
          latestDecision: result.decision,
          latestFactsHash: factsHash,
          previouslyConfirmed: input.previouslyConfirmed,
          latestLocked: result.decision.type === 'deny',
          latestRiskLevel: result.decision.type === 'require-confirm' ? result.decision.riskLevel : undefined,
          initialCallHash: initialFactsHash,
          latestCallHash: factsHash,
          initialAuthorizationEpoch,
          latestAuthorizationEpoch: input.resolveAuthorizationVersion(),
          initialEnvironmentHash: initialFactsHash,
          latestEnvironmentHash: factsHash,
          initialEgressHash: initialFactsHash,
          latestEgressHash: factsHash
        }) && !input.isRevoked(),
        authorizationVersion: input.resolveAuthorizationVersion() ?? result.decision.ruleId,
        targetVersion: `${result.decision.ruleId}:${result.decision.type}`,
        factsHash
      }
      return latest
    },
    safetyPolicy: createSafetyPolicyFromRecheck(async () => {
      const projection = latest
      latest = undefined
      return projection
    })
  }
}
