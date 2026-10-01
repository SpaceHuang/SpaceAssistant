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
  evaluateGate?: AgentSdkGateEvaluator
  resolveToolName?(providerToolName: string): string
  /** Attach structural read/write permits from the initial host gate to the call-private execution context. */
  onInitialGateResult?(binding: PermitBinding, result: ToolCallGateResult, args: ToolCallGateArgs): void | Promise<void>
  /** Finalize user-approved structural permits after the existing confirmation channel approves. */
  onConfirmed?(binding: PermitBinding, result: ToolCallGateResult, args: ToolCallGateArgs, answerer: 'user' | 'agent', memory?: import('../../src/shared/confirmation/types').CacheKey): void
}): SafetyPolicyPort & { markConfirmed(call: Pick<PermitBinding, 'invocationId' | 'toolCallId'>, answerer?: 'user' | 'agent', memory?: import('../../src/shared/confirmation/types').CacheKey): void } {
  const initial = new Map<string, { binding: PermitBinding; result: ToolCallGateResult; args: ToolCallGateArgs; confirmed: boolean }>()
  const callKey = (binding: PermitBinding) => JSON.stringify([binding.invocationId, binding.toolCallId])
  const deny = (binding: PermitBinding, reasonCode: SafetyDenyReason) => {
    if (binding.phase === 'recheck') initial.delete(callKey(binding))
    return { kind: 'deny' as const, reasonCode }
  }
  return {
    markConfirmed(call: Pick<PermitBinding, 'invocationId' | 'toolCallId'>, answerer: 'user' | 'agent' = 'user', memory?: import('../../src/shared/confirmation/types').CacheKey) {
      const decision = initial.get(JSON.stringify([call.invocationId, call.toolCallId]))
      if (decision) {
        input.onConfirmed?.(decision.binding, decision.result, decision.args, answerer, memory)
        decision.confirmed = true
      }
    },
    async evaluate(binding) {
      const key = callKey(binding)
      const previous = binding.phase === 'recheck' ? initial.get(key) : undefined
      if (binding.phase === 'recheck') {
        if (!previous) return { kind: 'deny', reasonCode: 'MISSING_MATERIAL' }
        // Claim before any asynchronous resolution so concurrent rechecks cannot reuse approval.
        initial.delete(key)
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
          if (!previous) return deny(binding, 'MISSING_MATERIAL')
          const sameFacts = createHash('sha256').update(JSON.stringify(previous.result.facts)).digest('hex') === createHash('sha256').update(JSON.stringify(result.facts)).digest('hex')
          const sameAuthorizationVersion = previous.binding.authorizationVersion === binding.authorizationVersion
          const sameWriteTarget = stableSerialize(previous.result.writePathFact) === stableSerialize(result.writePathFact)
          const sameReadTarget = stableSerialize(previous.result.readPathFact) === stableSerialize(result.readPathFact)
          const sameFeishuMediaTarget = stableSerialize(previous.result.feishuMediaFact) === stableSerialize(result.feishuMediaFact)
          const sameWriteApprovalConfiguration = !previous.result.writePathFact ||
            writeApprovalConfigurationSnapshot(previous.args) === writeApprovalConfigurationSnapshot(gateArgs)
          const sameConfirmedDecision = previous.confirmed &&
            (decision.type === 'auto-allow' || decision.type === 'require-confirm') &&
            decision.ruleId === previous.result.decision.ruleId && sameFacts
          const recheckAllowed = sameAuthorizationVersion && sameWriteTarget && sameReadTarget && sameFeishuMediaTarget && sameWriteApprovalConfiguration &&
            (previous.confirmed ? sameConfirmedDecision : decision.type === 'auto-allow')
          initial.delete(key)
          if (!recheckAllowed) {
            const confirmationScopeChanged = Boolean(previous.confirmed) && (
              !sameFacts || !sameWriteTarget || !sameReadTarget || !sameFeishuMediaTarget ||
              !sameWriteApprovalConfiguration || !sameConfirmedDecision
            )
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
          return {
            kind: 'ask', confirmationId: binding.toolCallId, answerer: decision.answerer, reasonCode: decision.ruleId,
            context: {
              toolName: gateArgs.toolName,
              ...(args.currentPageUrl ? { currentPageUrl: args.currentPageUrl } : {}),
              ...(args.dangerAssessment ? { dangerAssessment: args.dangerAssessment } : {}),
              ...(args.remoteBudgetState ? { remoteBudgetState: args.remoteBudgetState } : {}),
              decision: { riskLevel: decision.riskLevel, memoryTiers: decision.memoryTiers, timeoutMs: decision.timeoutMs, answerer: decision.answerer },
              facts: result.facts,
              approvedFactIds: result.approvedFactIds,
              ...(result.readTargetMapping ? { readTargetMapping: result.readTargetMapping } : {}),
              ...(result.readPathFact ? { readPathFact: result.readPathFact } : {}),
              ...(result.readExecutionPermit ? { readExecutionPermit: result.readExecutionPermit } : {}),
              ...(result.writePathFact ? { writePathFact: result.writePathFact } : {}),
              ...(result.writeExecutionPermit ? { writeExecutionPermit: result.writeExecutionPermit } : {}),
              ...(result.shellPrecheck ? { shellPrecheck: result.shellPrecheck } : {}),
              ...(result.autoApproveFallback ? { autoApproveFallback: result.autoApproveFallback } : {}),
              ...(result.mcpEntry ? { mcpEntry: result.mcpEntry } : {})
            }
          }
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
          approval: result.fileAutoApproved ? 'auto-allow' : 'confirmed'
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
          approval: result.fileAutoApproved ? 'auto-allow' : 'confirmed'
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
          previouslyConfirmed: input.previouslyConfirmed
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
