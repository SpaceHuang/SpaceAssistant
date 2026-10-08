import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CanonicalModelMessage, CanonicalToolCall } from './model'
import type { HistoryAppendResult, HistoryEvent } from './history'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type ContextScope =
  | Readonly<{ kind: 'session'; sessionId: string }>
  | Readonly<{ kind: 'invocation'; sessionId: string; invocationId: string }>
export type ContextItem = Readonly<{
  replayIdentity: string
  sourceMessageIds: readonly string[]
  message: CanonicalModelMessage
  sourceData: Readonly<Record<string, JsonValue>>
}>
export type ContextFrame = Readonly<{
  items: readonly ContextItem[]
  system: string
  windowId: string
  requiredUser?: Readonly<{ id: string; message: CanonicalModelMessage }>
  pendingTools: readonly CanonicalToolCall[]
}>
export type ContextFence = Readonly<{ token: string }>
export type ContextSnapshot = Readonly<{ scope: ContextScope; frame: ContextFrame; fence: ContextFence }>
export type ContextTransformationEvidence = Readonly<{ token: string }>
export type ContextCandidate = Readonly<{ base: ContextSnapshot; output: ContextFrame; evidence: ContextTransformationEvidence }>
export type ContextCommitReceipt = Readonly<{
  operationId: string
  windowId: string
  inputFingerprint: string
  outputFingerprint: string
  historyVersion?: number
}>
export type ContextCommitResult =
  | Readonly<{ status: 'committed'; snapshot: ContextSnapshot; receipt: ContextCommitReceipt }>
  | Readonly<{ status: 'stale' | 'busy' | 'no-op' | 'uncompressible' }>
  | Readonly<{ status: 'commit-uncertain'; receipt?: ContextCommitReceipt; error: Error }>

/** Stable SDK boundary shared by manual and automatic context replacement. */
export interface ContextPort {
  readCurrent(scope: ContextScope): Promise<ContextSnapshot>
  commitReplacement(input: Readonly<{
    operationId: string
    reason: 'manual-compact' | 'auto-compact' | 'window-transition'
    candidate: ContextCandidate
  }>): Promise<ContextCommitResult>
}

/** Internal storage-factory router; public consumers still receive only ContextPort. */
export function createContextPortRouter(): Readonly<{ port: ContextPort; bind(scope: ContextScope, port: ContextPort): () => void }> {
  const bindings = new Map<string, ContextPort>()
  const key = (scope: ContextScope) => scope.kind === 'session' ? `session:${scope.sessionId}` : `invocation:${scope.sessionId}:${scope.invocationId}`
  const route = (scope: ContextScope) => {
    const port = bindings.get(key(scope))
    if (!port) throw new Error('CONTEXT_SCOPE_NOT_BOUND')
    return port
  }
  const port: ContextPort = Object.freeze({
    readCurrent: async (scope: ContextScope) => route(scope).readCurrent(scope),
    commitReplacement: async (input: Parameters<ContextPort['commitReplacement']>[0]) => route(input.candidate.base.scope).commitReplacement(input)
  })
  return Object.freeze({
    port,
    bind: (scope, scopedPort) => {
      const scopeKey = key(scope)
      if (bindings.has(scopeKey)) throw new Error('CONTEXT_SCOPE_ALREADY_BOUND')
      bindings.set(scopeKey, scopedPort)
      return () => { if (bindings.get(scopeKey) === scopedPort) bindings.delete(scopeKey) }
    }
  })
}

/** Internal SDK-to-host callback after the SDK History writer commits a replacement event. */
export type ContextReplacement = Readonly<{
  scope: Readonly<{ invocationId: string; turnId: string }>
  reason: 'preflight' | 'turn-boundary' | 'provider-recovery'
  messages: readonly CanonicalModelMessage[]
  historyPayload?: Readonly<Record<string, unknown>>
  inputFingerprint: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}>

export type ContextProjectionCommitter = (candidate: ContextReplacement) => Promise<void>

export type ContextTransformationProof = Readonly<{
  historyPayload: Readonly<Record<string, JsonValue>>
  sourceBindings: readonly Readonly<{ outputIdentity: string; inputIdentities: readonly string[] }>[]
  checkpoint?: Readonly<Record<string, JsonValue>>
  shadowedRanges: readonly Readonly<{ start: string; end: string }>[]
  commitProjection?: () => void | Promise<void>
}>

/** Internal trusted signer; only context adapters/planners may hold this capability. */
export type ContextRegistrationBinding = Readonly<
  { kind: 'session'; surfaceFingerprint: string } |
  { kind: 'invocation'; phase: 'preflight' | 'boundary'; epoch: number; expectedHistoryVersion: number }
>

export interface ContextRegistrar {
  captureFrame(input: Readonly<{ scope: ContextScope; frame: ContextFrame; binding: ContextRegistrationBinding }>): ContextSnapshot
  registerTransformation(input: Readonly<{ base: ContextSnapshot; output: ContextFrame; proof: ContextTransformationProof }>): ContextCandidate
  readBinding(snapshot: ContextSnapshot): ContextRegistrationBinding
  resolveCandidate(candidate: ContextCandidate): Readonly<{ candidate: ContextCandidate; proof: ContextTransformationProof }>
  readEvidence(candidate: ContextCandidate): ContextTransformationProof
  release(candidate: ContextCandidate): void
  releaseSnapshot(snapshot: ContextSnapshot): void
}

export function createContextRegistrar(): ContextRegistrar {
  let nextFence = 0
  let nextEvidence = 0
  const snapshots = new Map<string, Readonly<{ snapshot: ContextSnapshot; binding: ContextRegistrationBinding }>>()
  const evidence = new Map<string, Readonly<{ candidate: ContextCandidate; proof: ContextTransformationProof }>>()
  const cloneFreeze = <T>(value: T): T => deepFreeze(structuredClone(value))
  const assertJson: (value: unknown, seen?: Set<object>) => asserts value is JsonValue = (value, seen = new Set<object>()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (typeof value !== 'object') throw new Error('CONTEXT_PROOF_NOT_JSON')
    if (seen.has(value)) throw new Error('CONTEXT_PROOF_NOT_JSON')
    seen.add(value)
    if (Array.isArray(value)) value.forEach((item) => assertJson(item, seen))
    else {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('CONTEXT_PROOF_NOT_JSON')
      for (const item of Object.values(value as Record<string, unknown>)) assertJson(item, seen)
    }
    seen.delete(value)
  }
  const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right)
  const registeredSnapshot = (snapshot: ContextSnapshot) => {
    const registered = snapshots.get(snapshot.fence.token)
    if (!registered || !same(registered.snapshot, snapshot)) throw new Error('CONTEXT_BASE_NOT_REGISTERED')
    return registered.snapshot
  }
  const registrar: ContextRegistrar = {
    captureFrame: ({ scope, frame, binding }) => {
      if (!scope.sessionId.trim() || (scope.kind === 'invocation' && !scope.invocationId.trim())) throw new Error('CONTEXT_SCOPE_REQUIRED')
      if (scope.kind === 'session') {
        if (binding.kind !== 'session' || !binding.surfaceFingerprint.trim()) throw new Error('CONTEXT_BINDING_MISMATCH')
      } else if (binding.kind !== 'invocation' || !Number.isInteger(binding.epoch) || binding.epoch < 0 || !Number.isInteger(binding.expectedHistoryVersion) || binding.expectedHistoryVersion < 0) {
        throw new Error('CONTEXT_BINDING_MISMATCH')
      }
      const snapshot = cloneFreeze({ scope, frame, fence: { token: `context-fence-${++nextFence}` } })
      snapshots.set(snapshot.fence.token, Object.freeze({ snapshot, binding: cloneFreeze(binding) }))
      return snapshot
    },
    registerTransformation: ({ base, output, proof }) => {
      const registeredBase = registeredSnapshot(base)
      assertJson(proof.historyPayload)
      assertJson(proof.sourceBindings)
      assertJson(proof.shadowedRanges)
      if (proof.checkpoint !== undefined) assertJson(proof.checkpoint)
      if (base.scope.kind !== registeredBase.scope.kind || !same(base.scope, registeredBase.scope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
      if (!same(base.frame.requiredUser, output.requiredUser)) throw new Error('CONTEXT_REQUIRED_USER_MISMATCH')
      if (!same(base.frame.pendingTools, output.pendingTools)) throw new Error('CONTEXT_PENDING_TOOLS_MISMATCH')
      const inputItems = new Map(base.frame.items.map((item) => [item.replayIdentity, item]))
      if (inputItems.size !== base.frame.items.length) throw new Error('CONTEXT_BASE_IDENTITY_DUPLICATE')
      const outputIdentities = new Set(output.items.map((item) => item.replayIdentity))
      if (outputIdentities.size !== output.items.length) throw new Error('CONTEXT_OUTPUT_IDENTITY_DUPLICATE')
      const bindings = new Map(proof.sourceBindings.map((binding) => [binding.outputIdentity, binding]))
      if (bindings.size !== proof.sourceBindings.length) throw new Error('CONTEXT_SOURCE_BINDING_MISMATCH')
      for (const item of output.items) {
        const binding = bindings.get(item.replayIdentity)
        if (item.sourceMessageIds.length === 0) {
          const retained = binding && binding.inputIdentities.length > 0 && binding.inputIdentities.every((identity) => {
            const source = inputItems.get(identity)
            return Boolean(source && source.sourceMessageIds.length === 0 && same(source.message, item.message))
          })
          if (retained) continue
          if (!proof.checkpoint || Object.keys(proof.checkpoint).length === 0) throw new Error('CONTEXT_CHECKPOINT_EVIDENCE_REQUIRED')
          const checkpointIdentity = proof.checkpoint.identity ?? proof.checkpoint.replayIdentity
          if (typeof checkpointIdentity !== 'string' || checkpointIdentity !== item.replayIdentity) throw new Error('CONTEXT_CHECKPOINT_EVIDENCE_MISMATCH')
          const ledger = proof.historyPayload.sessionLedger
          const summary = ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger.summary : undefined
          const candidate = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary.candidate : undefined
          const candidateMessage = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate.checkpointMessage : undefined
          const checkpointMessage = proof.checkpoint.checkpointMessage ?? candidateMessage
          if (!checkpointMessage || !same(checkpointMessage, item.message)) throw new Error('CONTEXT_CHECKPOINT_EVIDENCE_MISMATCH')
          continue
        }
        if (!binding || binding.inputIdentities.length === 0 || binding.inputIdentities.some((identity) => !inputItems.has(identity))) throw new Error('CONTEXT_SOURCE_BINDING_MISMATCH')
      const sourceIds = binding.inputIdentities.flatMap((identity) => inputItems.get(identity)!.sourceMessageIds)
        if (!same(sourceIds, item.sourceMessageIds)) throw new Error('CONTEXT_SOURCE_BINDING_MISMATCH')
      }
      if (proof.sourceBindings.some((binding) => !outputIdentities.has(binding.outputIdentity))) throw new Error('CONTEXT_SOURCE_BINDING_MISMATCH')
      const candidate = cloneFreeze({ base: registeredBase, output, evidence: { token: `context-evidence-${++nextEvidence}` } })
      const proofSnapshot = Object.freeze({
        historyPayload: cloneFreeze(proof.historyPayload), sourceBindings: cloneFreeze(proof.sourceBindings),
        ...(proof.checkpoint ? { checkpoint: cloneFreeze(proof.checkpoint) } : {}), shadowedRanges: cloneFreeze(proof.shadowedRanges),
        ...(proof.commitProjection ? { commitProjection: proof.commitProjection } : {})
      })
      evidence.set(candidate.evidence.token, Object.freeze({ candidate, proof: proofSnapshot }))
      return candidate
    },
    readBinding: (snapshot) => {
      registeredSnapshot(snapshot)
      return snapshots.get(snapshot.fence.token)!.binding
    },
    readEvidence: (candidate) => {
      return registrar.resolveCandidate(candidate).proof
    },
    resolveCandidate: (candidate) => {
      const registered = evidence.get(candidate.evidence.token)
      if (!registered) throw new Error('CONTEXT_EVIDENCE_NOT_REGISTERED')
      if (!same(registered.candidate.base, candidate.base) || !same(registered.candidate.output, candidate.output)) {
        throw new Error('CONTEXT_EVIDENCE_CANDIDATE_MISMATCH')
      }
      return Object.freeze({ candidate: registered.candidate, proof: registered.proof })
    },
    release: (candidate) => {
      evidence.delete(candidate.evidence.token)
      snapshots.delete(candidate.base.fence.token)
    },
    releaseSnapshot: (snapshot) => {
      registeredSnapshot(snapshot)
      snapshots.delete(snapshot.fence.token)
    }
  }
  return Object.freeze(registrar)
}

export type SessionContextCapture = Readonly<{ frame: ContextFrame; surfaceFingerprint: string }>
export type SessionContextPersistResult = Readonly<{ status: 'committed'; historyVersion?: number }> | Readonly<{ status: 'stale' | 'busy' | 'uncompressible' }>

/** Internal trusted planner capability paired with a session ContextPort. */
export type SessionContextAdapter = Readonly<{
  port: ContextPort
  registerTransformation(input: Readonly<{ base: ContextSnapshot; output: ContextFrame; proof: ContextTransformationProof }>): ContextCandidate
}>

/** Session-scope adapter: the host binds its existing transcript CAS and ledger transaction. */
export function createSessionContextPort(input: Readonly<{
  scope: Extract<ContextScope, { kind: 'session' }>
  registrar: ContextRegistrar
  capture(): Promise<SessionContextCapture>
  persist(input: Readonly<{
    operationId: string
    reason: 'manual-compact' | 'auto-compact' | 'window-transition'
    expectedSurfaceFingerprint: string
    inputFingerprint: string
    outputFingerprint: string
    output: ContextFrame
    historyPayload: Readonly<Record<string, JsonValue>>
  }>): Promise<SessionContextPersistResult>
}>): ContextPort {
  const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right)
  const fingerprint = (frame: ContextFrame) => createHash('sha256').update(JSON.stringify(frame.items.map(({ message }) => message))).digest('hex')
  const { scope, registrar } = input
  const port: ContextPort = {
    readCurrent: async (requestedScope) => {
      if (!same(scope, requestedScope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
      const current = await input.capture()
      return registrar.captureFrame({ scope, frame: current.frame, binding: { kind: 'session', surfaceFingerprint: current.surfaceFingerprint } })
    },
    commitReplacement: async ({ operationId, reason, candidate }) => {
      if (!operationId.trim()) throw new Error('CONTEXT_OPERATION_ID_REQUIRED')
      const resolved = registrar.resolveCandidate(candidate)
      const trustedCandidate = resolved.candidate
      const evidence = resolved.proof
      if (!same(trustedCandidate.base.scope, scope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
      const baseBinding = registrar.readBinding(trustedCandidate.base)
      if (baseBinding.kind !== 'session') throw new Error('CONTEXT_BINDING_MISMATCH')
      const current = await input.capture()
      if (current.surfaceFingerprint !== baseBinding.surfaceFingerprint || !same(current.frame, trustedCandidate.base.frame)) {
        registrar.release(trustedCandidate)
        return { status: 'stale' }
      }
      const inputFingerprint = baseBinding.surfaceFingerprint
      const outputFingerprint = fingerprint(trustedCandidate.output)
      let persisted: SessionContextPersistResult
      try {
        persisted = await input.persist({
          operationId, reason, expectedSurfaceFingerprint: inputFingerprint, inputFingerprint, outputFingerprint,
          output: trustedCandidate.output, historyPayload: evidence.historyPayload
        })
      } catch (error) {
        registrar.release(trustedCandidate)
        return { status: 'commit-uncertain', error: error instanceof Error ? error : new Error(String(error)) }
      }
      if (persisted.status !== 'committed') {
        registrar.release(trustedCandidate)
        return { status: persisted.status }
      }
      const receipt: ContextCommitReceipt = { operationId, windowId: trustedCandidate.output.windowId, inputFingerprint, outputFingerprint, ...(persisted.historyVersion !== undefined ? { historyVersion: persisted.historyVersion } : {}) }
      try {
        await evidence.commitProjection?.()
        const snapshot = registrar.captureFrame({ scope, frame: trustedCandidate.output, binding: { kind: 'session', surfaceFingerprint: outputFingerprint } })
        registrar.release(trustedCandidate)
        return { status: 'committed', snapshot, receipt }
      } catch (error) {
        registrar.release(trustedCandidate)
        return { status: 'commit-uncertain', receipt, error: error instanceof Error ? error : new Error(String(error)) }
      }
    }
  }
  return Object.freeze(port)
}

/** Internal composition helper; callers expose only `port` across business boundaries. */
export function createSessionContextAdapter(input: Parameters<typeof createSessionContextPort>[0]): SessionContextAdapter {
  const port = createSessionContextPort(input)
  return Object.freeze({ port, registerTransformation: (candidate) => input.registrar.registerTransformation(candidate) })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}


export type InvocationContextCapture = Readonly<{
  frame: ContextFrame
  phase: 'preflight' | 'boundary'
  epoch: number
  expectedHistoryVersion: number
}>

/** SDK-owned invocation writer binding; never exposed to ordinary ContextPort consumers. */
export type InvocationContextAppendResult = HistoryAppendResult | Readonly<{ status: 'uncompressible' }>

export interface InvocationContextBinding {
  readonly scope: Extract<ContextScope, { kind: 'invocation' }>
  capture(): Promise<InvocationContextCapture>
  appendReplacement(input: Readonly<{ epoch: number; expectedHistoryVersion: number; payload: Readonly<Record<string, unknown>> }>): Promise<InvocationContextAppendResult>
  applyCommitted(input: Readonly<{ frame: ContextFrame; epoch: number; historyVersion: number }>): void
}

export function createInvocationContextPort(input: Readonly<{ binding: InvocationContextBinding; registrar: ContextRegistrar }>): ContextPort {
  const { binding, registrar } = input
  const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right)
  const hash = (messages: readonly CanonicalModelMessage[]) => createHash('sha256').update(JSON.stringify(messages)).digest('hex')
  const isUnknownCommit = (error: unknown): error is Error => error instanceof Error && (error.name === 'TransactionCommitUnknownError' || (error as Error & { code?: string }).code === 'commit-uncertain')
  const port: ContextPort = {
    readCurrent: async (scope) => {
      if (!same(scope, binding.scope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
      const current = await binding.capture()
      return registrar.captureFrame({ scope: binding.scope, frame: current.frame, binding: {
        kind: 'invocation', phase: current.phase, epoch: current.epoch, expectedHistoryVersion: current.expectedHistoryVersion
      } })
    },
    commitReplacement: async ({ operationId, candidate }) => {
      if (!operationId.trim()) throw new Error('CONTEXT_OPERATION_ID_REQUIRED')
      const resolved = registrar.resolveCandidate(candidate)
      const trustedCandidate = resolved.candidate
      const evidence = resolved.proof
      if (!same(trustedCandidate.base.scope, binding.scope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
      const baseBinding = registrar.readBinding(trustedCandidate.base)
      if (baseBinding.kind !== 'invocation') throw new Error('CONTEXT_BINDING_MISMATCH')
      const current = await binding.capture()
      if (current.phase !== baseBinding.phase || current.epoch !== baseBinding.epoch || current.expectedHistoryVersion !== baseBinding.expectedHistoryVersion || !same(current.frame, trustedCandidate.base.frame)) {
        registrar.release(trustedCandidate)
        return { status: 'stale' }
      }
      if (same(trustedCandidate.base.frame, trustedCandidate.output) && !evidence.commitProjection) {
        registrar.release(trustedCandidate)
        return { status: 'no-op' }
      }
      const inputMessages = trustedCandidate.base.frame.items.map(({ message }) => message)
      const outputMessages = trustedCandidate.output.items.map(({ message }) => message)
      const inputFingerprint = hash(inputMessages)
      const outputFingerprint = hash(outputMessages)
      const reserved: Record<string, unknown> = {
        messages: outputMessages,
        inputFingerprint,
        outputFingerprint,
        ...(trustedCandidate.output.requiredUser ? { requiredUserMessage: trustedCandidate.output.requiredUser } : {})
      }
      for (const [key, value] of Object.entries(reserved)) {
        if (key in evidence.historyPayload && !same(evidence.historyPayload[key], value)) {
          registrar.release(trustedCandidate)
          throw new Error(`CONTEXT_HISTORY_PAYLOAD_CONFLICT:${key}`)
        }
      }
      const payload = { ...evidence.historyPayload, ...reserved }
      let appended: InvocationContextAppendResult
      try {
        appended = await binding.appendReplacement({ epoch: current.epoch, expectedHistoryVersion: current.expectedHistoryVersion, payload })
      } catch (error) {
        registrar.release(trustedCandidate)
        if (error instanceof Error && ((error as Error & { code?: string }).code === 'version-conflict' || error.message === 'CONTEXT_EPOCH_STALE')) return { status: 'stale' }
        if (isUnknownCommit(error)) return { status: 'commit-uncertain', error }
        throw error
      }
      if ('status' in appended && appended.status === 'uncompressible') {
        registrar.release(trustedCandidate)
        return { status: 'uncompressible' }
      }
      if ('status' in appended) throw new Error('CONTEXT_APPEND_RESULT_INVALID')
      const receipt: ContextCommitReceipt = {
        operationId, windowId: trustedCandidate.output.windowId, inputFingerprint, outputFingerprint, historyVersion: appended.version
      }
      try {
        await evidence.commitProjection?.()
        const snapshot = registrar.captureFrame({ scope: binding.scope, frame: trustedCandidate.output, binding: {
          kind: 'invocation', phase: current.phase, epoch: current.epoch + 1, expectedHistoryVersion: appended.version
        } })
        binding.applyCommitted({ frame: trustedCandidate.output, epoch: current.epoch + 1, historyVersion: appended.version })
        registrar.release(trustedCandidate)
        return { status: 'committed', snapshot, receipt }
      } catch (error) {
        registrar.release(trustedCandidate)
        return { status: 'commit-uncertain', receipt, error: error instanceof Error ? error : new Error(String(error)) }
      }
    }
  }
  return Object.freeze(port)
}
