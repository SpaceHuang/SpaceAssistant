export type PermitBinding = Readonly<{
  requestId: string
  turnId: string
  invocationId: string
  toolCallId: string
  capabilityId: string
  inputSnapshotHash: string
  planDigest: string
  factsDigest: string
  authorizationVersion: string
  phase: 'initial-compat' | 'recheck'
}>

export type PermitConsumeResult = { ok: true } | {
  ok: false
  reason: 'UNKNOWN' | 'BINDING_MISMATCH' | 'EXPIRED' | 'CANCELLED' | 'CONSUMED' | 'AUTHORIZATION_STALE'
}

export interface SafetyPermitStore {
  issue(binding: PermitBinding, expiresAt: number): string
  consume(permitId: string, expected: PermitBinding): Promise<PermitConsumeResult>
  invalidateInvocation(requestId: string, reason: 'cancelled' | 'revoked' | 'expired'): void
  invalidateBinding(requestId: string, invocationId: string, reason: 'cancelled' | 'revoked' | 'authorization-changed'): void
  clearInvocation(requestId: string): void
  settle(permitId: string): void
}

type PermitRecord = { binding: PermitBinding; expiresAt: number; state: 'issued' | 'consumed' | 'invalid'; invalidReason?: 'CANCELLED' | 'AUTHORIZATION_STALE' }

/** In-memory reference implementation. Production hosts can persist only for an invocation lifetime. */
export class InMemorySafetyPermitStore implements SafetyPermitStore {
  private readonly records = new Map<string, PermitRecord>()
  private readonly invalidRequests = new Map<string, 'CANCELLED' | 'AUTHORIZATION_STALE'>()
  private readonly invalidBindings = new Map<string, 'CANCELLED' | 'AUTHORIZATION_STALE'>()

  issue(binding: PermitBinding, expiresAt: number): string {
    if (!Number.isFinite(expiresAt)) throw new Error('expiresAt must be finite')
    if (expiresAt <= Date.now()) throw new Error('permit expiration must be in the future')
    const permitId = randomId()
    this.records.set(permitId, { binding: Object.freeze({ ...binding }), expiresAt, state: 'issued' })
    return permitId
  }

  async consume(permitId: string, expected: PermitBinding): Promise<PermitConsumeResult> {
    const record = this.records.get(permitId)
    if (!record) return { ok: false, reason: 'UNKNOWN' }
    if (record.state === 'consumed') return { ok: false, reason: 'CONSUMED' }
    if (record.state === 'invalid') return { ok: false, reason: record.invalidReason ?? 'CANCELLED' }
    if (record.expiresAt <= Date.now()) {
      record.state = 'invalid'
      return { ok: false, reason: 'EXPIRED' }
    }
    if (this.invalidRequests.has(expected.requestId)) {
      record.state = 'invalid'
      record.invalidReason = this.invalidRequests.get(expected.requestId)
      return { ok: false, reason: record.invalidReason ?? 'CANCELLED' }
    }
    const bindingInvalidation = this.invalidBindings.get(bindingKey(expected.requestId, expected.invocationId))
    if (bindingInvalidation) {
      record.state = 'invalid'
      record.invalidReason = bindingInvalidation
      return { ok: false, reason: bindingInvalidation }
    }
    if (!sameBinding(record.binding, expected)) return { ok: false, reason: 'BINDING_MISMATCH' }
    record.state = 'consumed'
    return { ok: true }
  }

  invalidateInvocation(requestId: string, reason: 'cancelled' | 'revoked' | 'expired'): void {
    const failure = reason === 'cancelled' ? 'CANCELLED' : 'AUTHORIZATION_STALE'
    this.invalidRequests.set(requestId, failure)
    for (const record of this.records.values()) {
      if (record.binding.requestId === requestId && record.state === 'issued') {
        record.state = 'invalid'
        record.invalidReason = failure
      }
    }
  }

  invalidateBinding(requestId: string, invocationId: string, reason: 'cancelled' | 'revoked' | 'authorization-changed'): void {
    const key = bindingKey(requestId, invocationId)
    const failure = reason === 'cancelled' ? 'CANCELLED' : 'AUTHORIZATION_STALE'
    this.invalidBindings.set(key, failure)
    for (const record of this.records.values()) {
      if (record.binding.requestId === requestId && record.binding.invocationId === invocationId && record.state === 'issued') {
        record.state = 'invalid'
        record.invalidReason = failure
      }
    }
  }

  clearInvocation(requestId: string): void {
    this.invalidRequests.delete(requestId)
    for (const key of this.invalidBindings.keys()) {
      const pair = JSON.parse(key) as [string, string]
      if (pair[0] === requestId) this.invalidBindings.delete(key)
    }
    for (const [id, record] of this.records) if (record.binding.requestId === requestId) this.records.delete(id)
  }

  settle(permitId: string): void { this.records.delete(permitId) }
}

function bindingKey(requestId: string, invocationId: string): string { return JSON.stringify([requestId, invocationId]) }

function sameBinding(a: PermitBinding, b: PermitBinding): boolean {
  const keys: Array<keyof PermitBinding> = [
    'requestId', 'turnId', 'invocationId', 'toolCallId', 'capabilityId', 'inputSnapshotHash',
    'planDigest', 'factsDigest', 'authorizationVersion', 'phase'
  ]
  return keys.every((key) => a[key] === b[key])
}

function randomId(): string {
  const cryptoObject = globalThis.crypto
  if (!cryptoObject?.getRandomValues) throw new Error('secure random source unavailable')
  const bytes = new Uint8Array(24)
  cryptoObject.getRandomValues(bytes)
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}
