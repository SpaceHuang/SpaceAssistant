import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type ReviewScopeLane = 'desktop' | 'feishu' | 'wechat'
export type ReviewScopeSource = 'agent' | 'user'
export type ReviewScopeState = 'pending_first_write' | 'active' | 'write_pending'

export interface ReviewScopeCandidate {
  readonly lane: ReviewScopeLane
  readonly sessionId: string
  readonly subjectId: string
  readonly authorizationDomain: { readonly id: string; readonly revision: number; readonly epoch: number }
  readonly toolName: 'edit_file' | 'write_file' | 'grep'
  readonly operation: 'edit' | 'write' | 'search'
  /** Complete host-derived target set. Each target retains its semantic role. */
  readonly objects: readonly { readonly role: string; readonly value: string }[]
  readonly environment: string
  readonly policyVersion: string
  /** Complete authoritative task text; only its session-keyed HMAC is retained. */
  readonly taskConstraint: string
  /** Host-projected capability parameters; never pass raw model parameters here. */
  readonly exactParameters: unknown
}

export interface ReviewFileReceipt {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly size: number
  readonly nlink: number
  readonly sha256: string
}

export interface ReviewScopeEntryView {
  readonly source: ReviewScopeSource
  readonly state: ReviewScopeState
  readonly generation: number
  readonly receipt?: ReviewFileReceipt
}

export interface ReviewWriteLease {
  readonly digest: string
  readonly generation: number
}

interface ReviewScopeEntry {
  readonly digest: string
  readonly sessionKey: string
  readonly source: ReviewScopeSource
  state: ReviewScopeState
  generation: number
  touchedAt: number
  receipt?: ReviewFileReceipt
}

export interface ReviewScopeCacheOptions {
  readonly maxEntriesPerSession?: number
  readonly maxEntriesTotal?: number
  readonly maxEntryBytes?: number
  readonly randomBytes?: (size: number) => Buffer
  readonly now?: () => number
}

const DEFAULT_MAX_PER_SESSION = 512
const DEFAULT_MAX_TOTAL = 4096
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024
const HASH_PATTERN = /^[a-f0-9]{64}$/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Canonical JSON: object keys are sorted, arrays retain order; unsupported values fail closed. */
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('REVIEW_SCOPE_PARAMETERS_INVALID')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) throw new Error('REVIEW_SCOPE_PARAMETERS_INVALID')
    seen.add(value)
    const entries = Object.keys(value).sort().map((key) => {
      const item = value[key]
      if (item === undefined) throw new Error('REVIEW_SCOPE_PARAMETERS_INVALID')
      return `${JSON.stringify(key)}:${canonicalJson(item, seen)}`
    })
    seen.delete(value)
    return `{${entries.join(',')}}`
  }
  throw new Error('REVIEW_SCOPE_PARAMETERS_INVALID')
}

function sessionKey(lane: ReviewScopeLane, sessionId: string): string {
  return `${lane}\0${sessionId}`
}

function validateCandidate(scope: ReviewScopeCandidate): void {
  if (!scope || !['desktop', 'feishu', 'wechat'].includes(scope.lane) || !scope.sessionId.trim() || !scope.subjectId.trim() ||
    !scope.authorizationDomain?.id.trim() || !Number.isSafeInteger(scope.authorizationDomain.revision) || scope.authorizationDomain.revision < 0 ||
    !Number.isSafeInteger(scope.authorizationDomain.epoch) || scope.authorizationDomain.epoch < 0 || !scope.environment.trim() || !scope.policyVersion.trim() || !scope.taskConstraint.trim()) {
    throw new Error('REVIEW_SCOPE_IDENTITY_INVALID')
  }
  if ((scope.toolName === 'edit_file' && scope.operation !== 'edit') || (scope.toolName === 'write_file' && scope.operation !== 'write') ||
    (scope.toolName === 'grep' && scope.operation !== 'search')) throw new Error('REVIEW_SCOPE_CAPABILITY_INVALID')
  if (!Array.isArray(scope.objects) || scope.objects.length === 0) throw new Error('REVIEW_SCOPE_OBJECTS_REQUIRED')
  const seen = new Set<string>()
  for (const object of scope.objects) {
    if (!object || !object.role.trim() || !object.value.trim()) throw new Error('REVIEW_SCOPE_OBJECT_INVALID')
    const key = `${object.role}\0${object.value}`
    if (seen.has(key)) throw new Error('REVIEW_SCOPE_OBJECT_DUPLICATE')
    seen.add(key)
  }
  canonicalJson(scope.exactParameters)
}

function validReceipt(receipt: ReviewFileReceipt): boolean {
  return Number.isSafeInteger(receipt.dev) && Number.isSafeInteger(receipt.ino) && Number.isSafeInteger(receipt.mode) &&
    Number.isSafeInteger(receipt.size) && receipt.size >= 0 && receipt.nlink === 1 && HASH_PATTERN.test(receipt.sha256) &&
    (receipt.mode & 0o170000) === 0o100000
}

/**
 * In-memory, session-scoped review grants. This module stores only keyed digests and narrow metadata;
 * the host must still run current policy/facts checks and validate the returned file receipt per call.
 */
export class ReviewScopeCache {
  private readonly sessionSecrets = new Map<string, Buffer>()
  private readonly entries = new Map<string, ReviewScopeEntry>()
  private readonly maxEntriesPerSession: number
  private readonly maxEntriesTotal: number
  private readonly maxEntryBytes: number
  private readonly randomBytes: (size: number) => Buffer
  private readonly now: () => number
  private generation = 0

  constructor(options: ReviewScopeCacheOptions = {}) {
    this.maxEntriesPerSession = options.maxEntriesPerSession ?? DEFAULT_MAX_PER_SESSION
    this.maxEntriesTotal = options.maxEntriesTotal ?? DEFAULT_MAX_TOTAL
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.randomBytes = options.randomBytes ?? randomBytes
    this.now = options.now ?? Date.now
  }

  candidateDigest(scope: ReviewScopeCandidate): string {
    validateCandidate(scope)
    const key = sessionKey(scope.lane, scope.sessionId)
    let secret = this.sessionSecrets.get(key)
    if (!secret) {
      secret = this.randomBytes(32)
      if (secret.length !== 32) throw new Error('REVIEW_SCOPE_SECRET_UNAVAILABLE')
      this.sessionSecrets.set(key, secret)
    }
    const objects = [...scope.objects].sort((a, b) => a.role.localeCompare(b.role) || a.value.localeCompare(b.value))
    const canonical = canonicalJson({
      version: 1,
      lane: scope.lane,
      sessionId: scope.sessionId,
      subjectId: scope.subjectId,
      authorizationDomain: scope.authorizationDomain,
      toolName: scope.toolName,
      operation: scope.operation,
      objects,
      environment: scope.environment,
      policyVersion: scope.policyVersion,
      taskConstraint: scope.taskConstraint,
      exactParameters: scope.exactParameters
    })
    return createHmac('sha256', secret).update(canonical).digest('hex')
  }

  /** A grant is accepted only when the reviewer echoes the exact host-created candidate token. */
  grant(input: { scope: ReviewScopeCandidate; source: ReviewScopeSource; scopeCandidateDigest: string }): boolean {
    const expected = this.candidateDigest(input.scope)
    if (!HASH_PATTERN.test(input.scopeCandidateDigest) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.scopeCandidateDigest, 'hex'))) return false
    const key = sessionKey(input.scope.lane, input.scope.sessionId)
    const digest = expected
    const state: ReviewScopeState = input.scope.toolName === 'grep' ? 'active' : 'pending_first_write'
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ digest, key, source: input.source, state, generation: this.generation + 1 }))
    if (estimatedBytes > this.maxEntryBytes) return false
    if (this.entries.has(digest)) return false
    if (!this.makeRoom(key)) return false
    this.entries.set(digest, {
      digest,
      sessionKey: key,
      source: input.source,
      state,
      generation: ++this.generation,
      touchedAt: this.now()
    })
    return true
  }

  /** Register only a host-issued, reviewer-echoed opaque candidate digest. */
  grantDigest(input: { lane: ReviewScopeLane; sessionId: string; source: ReviewScopeSource; scopeCandidateDigest: string; firstWrite: boolean }): boolean {
    const digest = input.scopeCandidateDigest
    if (!HASH_PATTERN.test(digest) || !input.sessionId.trim()) return false
    const key = sessionKey(input.lane, input.sessionId)
    if (!this.sessionSecrets.has(key)) return false
    const state: ReviewScopeState = input.firstWrite ? 'pending_first_write' : 'active'
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ digest, key, source: input.source, state, generation: this.generation + 1 }))
    if (estimatedBytes > this.maxEntryBytes || this.entries.has(digest) || !this.makeRoom(key)) return false
    this.entries.set(digest, { digest, sessionKey: key, source: input.source, state, generation: ++this.generation, touchedAt: this.now() })
    return true
  }

  lookup(scope: ReviewScopeCandidate): ReviewScopeEntryView | null {
    let digest: string
    try { digest = this.candidateDigest(scope) } catch { return null }
    const entry = this.entries.get(digest)
    if (!entry || entry.state !== 'active') return null
    entry.touchedAt = this.now()
    return this.toView(entry)
  }

  state(scope: ReviewScopeCandidate): ReviewScopeEntryView | null {
    let digest: string
    try { digest = this.candidateDigest(scope) } catch { return null }
    const entry = this.entries.get(digest)
    return entry ? this.toView(entry) : null
  }

  activateFirstWrite(scope: ReviewScopeCandidate, scopeCandidateDigest: string, receipt: ReviewFileReceipt): boolean {
    if (!validReceipt(receipt)) return false
    const digest = this.matchingDigest(scope, scopeCandidateDigest)
    if (!digest) return false
    const entry = this.entries.get(digest)
    if (!entry || entry.state !== 'pending_first_write') return false
    entry.receipt = Object.freeze({ ...receipt })
    entry.state = 'active'
    entry.generation = ++this.generation
    entry.touchedAt = this.now()
    return true
  }

  beginWrite(scope: ReviewScopeCandidate): ReviewWriteLease | null {
    const view = this.lookup(scope)
    if (!view || !view.receipt) return null
    const digest = this.candidateDigest(scope)
    const entry = this.entries.get(digest)
    if (!entry || entry.state !== 'active') return null
    entry.state = 'write_pending'
    entry.generation = ++this.generation
    entry.touchedAt = this.now()
    return Object.freeze({ digest, generation: entry.generation })
  }

  completeWrite(lease: ReviewWriteLease, receipt: ReviewFileReceipt): boolean {
    const entry = this.entries.get(lease.digest)
    if (!entry || entry.state !== 'write_pending' || entry.generation !== lease.generation || !validReceipt(receipt)) return false
    entry.receipt = Object.freeze({ ...receipt })
    entry.state = 'active'
    entry.generation = ++this.generation
    entry.touchedAt = this.now()
    return true
  }

  failWrite(lease: ReviewWriteLease): boolean {
    const entry = this.entries.get(lease.digest)
    if (!entry || entry.state !== 'write_pending' || entry.generation !== lease.generation) return false
    this.revokeEntry(entry)
    return true
  }

  revoke(scope: ReviewScopeCandidate): boolean {
    let digest: string
    try { digest = this.candidateDigest(scope) } catch { return false }
    const entry = this.entries.get(digest)
    if (!entry) return false
    this.revokeEntry(entry)
    return true
  }

  clearSession(lane: ReviewScopeLane, sessionId: string): void {
    const key = sessionKey(lane, sessionId)
    this.sessionSecrets.get(key)?.fill(0)
    this.sessionSecrets.delete(key)
    for (const [digest, entry] of this.entries) {
      if (entry.sessionKey === key) {
        entry.generation = ++this.generation
        this.entries.delete(digest)
      }
    }
  }

  clearAll(): void {
    for (const secret of this.sessionSecrets.values()) secret.fill(0)
    this.sessionSecrets.clear()
    for (const entry of this.entries.values()) entry.generation = ++this.generation
    this.entries.clear()
  }

  get size(): number { return this.entries.size }

  private matchingDigest(scope: ReviewScopeCandidate, candidateDigest: string): string | null {
    let expected: string
    try { expected = this.candidateDigest(scope) } catch { return null }
    if (!HASH_PATTERN.test(candidateDigest)) return null
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidateDigest, 'hex')) ? expected : null
  }

  private makeRoom(key: string): boolean {
    const countForSession = () => [...this.entries.values()].filter((entry) => entry.sessionKey === key).length
    while (this.entries.size >= this.maxEntriesTotal || countForSession() >= this.maxEntriesPerSession) {
      const oldest = [...this.entries.values()]
        .filter((entry) => entry.state === 'active')
        .sort((a, b) => a.touchedAt - b.touchedAt || a.generation - b.generation)[0]
      if (!oldest) return false
      this.revokeEntry(oldest)
    }
    return true
  }

  private revokeEntry(entry: ReviewScopeEntry): void {
    entry.state = 'write_pending'
    entry.generation = ++this.generation
    entry.receipt = undefined
    this.entries.delete(entry.digest)
  }

  private toView(entry: ReviewScopeEntry): ReviewScopeEntryView {
    return Object.freeze({ source: entry.source, state: entry.state, generation: entry.generation, ...(entry.receipt ? { receipt: entry.receipt } : {}) })
  }
}
