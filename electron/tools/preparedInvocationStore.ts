import { createHash } from 'node:crypto'
import type { PermitBinding } from '../../packages/agent-sdk/src/safetyPermit'
import type { PreparedInvocation } from './plannedToolRegistry'

export type PreparedBindingContext = Readonly<{
  invocationId: string
  requestId: string
  turnId: string
  toolCallId: string
  toolName: string
  canonicalInput: unknown
  targetVersion: string
  factsHash?: string
  authorizationVersion: string
  phase: PermitBinding['phase']
}>

type PreparedRecord = Readonly<{
  invocationId: string
  requestId: string
  turnId: string
  toolCallId: string
  toolName: string
  canonicalInputHash: string
  canonicalInput: unknown
  inputMappingVersion: string
  planDigest: string
  factsDigest: string
  displayDigest: string
  targetVersion: string
  factsHash: string
  invalidated: boolean
}>

export type PreparedInvocationRejectReason =
  | 'UNKNOWN_INVOCATION'
  | 'INVOCATION_INVALIDATED'
  | 'BINDING_MISMATCH'
  | 'INPUT_SNAPSHOT_MISMATCH'
  | 'TARGET_VERSION_CHANGED'

export class PreparedInvocationStoreError extends Error {
  readonly code = 'prepared-invocation-rejected'
  constructor(readonly reason: PreparedInvocationRejectReason | 'INPUT_MAPPING_VERSION_MISMATCH') { super(`prepared invocation rejected: ${reason}`); this.name = 'PreparedInvocationStoreError' }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`
}

function inputHash(input: unknown): string {
  const json = JSON.stringify(input)
  if (json === undefined || stable(JSON.parse(json)) !== stable(input)) throw new Error('prepared invocation input must be canonical JSON')
  return createHash('sha256').update(stable(input)).digest('hex')
}

/** Host-private, executor-free record store. It never accepts or stores a permit object. */
export class PreparedInvocationStore {
  private readonly records = new Map<string, PreparedRecord>()

  put(prepared: PreparedInvocation, context: { turnId: string; canonicalInput: unknown; inputMappingVersion: string; targetVersion: string; factsHash?: string }): void {
    if (this.records.has(prepared.invocationId)) throw new Error('DUPLICATE_PREPARED_INVOCATION')
    if (!context.turnId.trim() || !context.inputMappingVersion.trim() || !context.targetVersion.trim()) throw new Error('PREPARED_INVOCATION_CONTEXT_REQUIRED')
    const canonicalInput = deepFreeze(structuredClone(context.canonicalInput))
    const canonicalInputHash = inputHash(canonicalInput)
    if (prepared.inputDigest !== canonicalInputHash) throw new PreparedInvocationStoreError('INPUT_SNAPSHOT_MISMATCH')
    this.records.set(prepared.invocationId, Object.freeze({
      invocationId: prepared.invocationId,
      requestId: prepared.requestId,
      turnId: context.turnId,
      toolCallId: prepared.toolUseId,
      toolName: prepared.toolName,
      canonicalInputHash,
      canonicalInput,
      inputMappingVersion: context.inputMappingVersion,
      planDigest: prepared.planDigest,
      factsDigest: prepared.factsDigest,
      displayDigest: prepared.displayDigest,
      targetVersion: context.targetVersion,
      factsHash: context.factsHash ?? prepared.factsDigest,
      invalidated: false
    }))
  }

  resolveExpected(context: PreparedBindingContext): PermitBinding {
    const record = this.records.get(context.invocationId)
    if (!record) throw new PreparedInvocationStoreError('UNKNOWN_INVOCATION')
    if (record.invalidated) throw new PreparedInvocationStoreError('INVOCATION_INVALIDATED')
    if (record.requestId !== context.requestId || record.turnId !== context.turnId || record.toolCallId !== context.toolCallId || record.toolName !== context.toolName) {
      throw new PreparedInvocationStoreError('BINDING_MISMATCH')
    }
    if (inputHash(context.canonicalInput) !== record.canonicalInputHash) throw new PreparedInvocationStoreError('INPUT_SNAPSHOT_MISMATCH')
    if (context.targetVersion !== record.targetVersion) throw new PreparedInvocationStoreError('TARGET_VERSION_CHANGED')
    if (context.factsHash !== undefined && context.factsHash !== record.factsHash) throw new PreparedInvocationStoreError('BINDING_MISMATCH')
    if (!context.authorizationVersion.trim()) throw new PreparedInvocationStoreError('BINDING_MISMATCH')
    return Object.freeze({
      requestId: record.requestId,
      turnId: record.turnId,
      invocationId: record.invocationId,
      toolCallId: record.toolCallId,
      capabilityId: record.toolName,
      inputSnapshotHash: record.canonicalInputHash,
      planDigest: record.planDigest,
      factsDigest: record.factsHash,
      authorizationVersion: context.authorizationVersion,
      phase: context.phase
    })
  }

  validateExpected(context: PreparedBindingContext, expected: PermitBinding): boolean {
    try {
      const current = this.resolveExpected(context)
      return Object.keys(current).every((key) => current[key as keyof PermitBinding] === expected[key as keyof PermitBinding])
    } catch {
      return false
    }
  }

  readCanonicalInput(invocationId: string, inputMappingVersion: string): unknown {
    const record = this.records.get(invocationId)
    if (!record) throw new PreparedInvocationStoreError('UNKNOWN_INVOCATION')
    if (record.invalidated) throw new PreparedInvocationStoreError('INVOCATION_INVALIDATED')
    if (record.inputMappingVersion !== inputMappingVersion) throw new PreparedInvocationStoreError('INPUT_MAPPING_VERSION_MISMATCH')
    return structuredClone(record.canonicalInput)
  }

  invalidate(invocationId: string): void {
    const record = this.records.get(invocationId)
    if (record) this.records.set(invocationId, Object.freeze({ ...record, invalidated: true }))
  }

  settle(invocationId: string): void { this.records.delete(invocationId) }
  has(invocationId: string): boolean { return this.records.has(invocationId) }
}
