import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import type { ReviewScopeGrantIdentity, ReviewScopeGrantStore, ReviewScopeLifetime } from './reviewScopeGrantStore'
import { isGrepSubtreeSemanticallyContained } from '../tools/grepScope'

export type ReviewScopeLane = 'desktop' | 'feishu' | 'wechat'
export type ReviewScopeSource = 'agent' | 'user'
export type ReviewScopeState = 'active'

export interface ReviewScopeCandidate {
  readonly lane: ReviewScopeLane
  readonly sessionId: string
  readonly subjectId: string
  readonly authorizationDomain: { readonly id: string; readonly revision: number; readonly epoch: number }
  readonly toolName: 'edit_file' | 'write_file' | 'grep' | 'list_work_dirs'
  readonly operation: 'edit' | 'write' | 'search' | 'list'
  /** Complete host-derived target set. Each target retains its semantic role. */
  readonly objects: readonly { readonly role: string; readonly value: string }[]
  readonly environment: string
  readonly policyVersion: string
  /** Complete authoritative task text; only its session-keyed HMAC is retained. */
  readonly taskConstraint: string
  /** Host-projected capability parameters; never pass raw model parameters here. */
  readonly exactParameters: unknown
  /** Captured from settings when this approval request is created. */
  readonly approvalLifetime?: ReviewScopeLifetime
}

export interface ReviewScopeEntryView {
  readonly source: ReviewScopeSource
  readonly state: ReviewScopeState
  readonly generation: number
  readonly inheritedParentScope?: { readonly root: string; readonly ignoreDigest: string; readonly engine: 'ripgrep' | 'walk'; readonly engineFingerprint: string; readonly extraExcludeDirNames: readonly string[] }
}

interface ReviewScopeEntry {
  readonly digest: string
  readonly sessionKey: string
  readonly source: ReviewScopeSource
  state: ReviewScopeState
  generation: number
  touchedAt: number
}

export interface ReviewScopeCacheOptions {
  readonly maxEntriesPerSession?: number
  readonly maxEntriesTotal?: number
  readonly maxEntryBytes?: number
  readonly randomBytes?: (size: number) => Buffer
  readonly now?: () => number
  readonly grantStore?: ReviewScopeGrantStore
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

function isGrepRootEligible(root: string): boolean { return path.isAbsolute(root) }

function isSubPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function sameGrepQuery(parent: ReviewScopeCandidate, candidate: ReviewScopeCandidate): boolean {
  const queryKey = (value: unknown): string => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return canonicalJson(value)
    const { ignoreDigest: _ignoreDigest, ...query } = value as Record<string, unknown>
    return canonicalJson(query)
  }
  return parent.lane === candidate.lane && parent.sessionId === candidate.sessionId && parent.subjectId === candidate.subjectId &&
    parent.environment === candidate.environment && parent.policyVersion === candidate.policyVersion &&
    parent.authorizationDomain.id === candidate.authorizationDomain.id && parent.authorizationDomain.epoch === candidate.authorizationDomain.epoch &&
    parent.authorizationDomain.revision === candidate.authorizationDomain.revision &&
    queryKey(parent.exactParameters) === queryKey(candidate.exactParameters)
}

function canInheritGrepRoot(parent: ReviewScopeCandidate, candidate: ReviewScopeCandidate): boolean {
  if (!sameGrepQuery(parent, candidate)) return false
  const parentRoot = parent.objects[0]!.value
  const childRoot = candidate.objects[0]!.value
  const parentOptions = parent.exactParameters as { includeIgnored?: unknown; glob?: unknown; ignoreDigest?: unknown }
  const childOptions = candidate.exactParameters as { includeIgnored?: unknown; glob?: unknown; ignoreDigest?: unknown }
  return typeof parentOptions.ignoreDigest === 'string' && /^[a-f0-9]{64}$/.test(parentOptions.ignoreDigest) &&
    typeof childOptions.ignoreDigest === 'string' && /^[a-f0-9]{64}$/.test(childOptions.ignoreDigest) &&
    isGrepSubtreeSemanticallyContained(parentRoot, childRoot, {
      includeIgnored: parentOptions.includeIgnored === true,
      ...(typeof parentOptions.glob === 'string' ? { glob: parentOptions.glob } : {})
    })
}

function validateCandidate(scope: ReviewScopeCandidate): void {
  if (!scope || !['desktop', 'feishu', 'wechat'].includes(scope.lane) || !scope.sessionId.trim() || !scope.subjectId.trim() ||
    !scope.authorizationDomain?.id.trim() || !Number.isSafeInteger(scope.authorizationDomain.revision) || scope.authorizationDomain.revision < 0 ||
    !Number.isSafeInteger(scope.authorizationDomain.epoch) || scope.authorizationDomain.epoch < 0 || !scope.environment.trim() || !scope.policyVersion.trim()) {
    throw new Error('REVIEW_SCOPE_IDENTITY_INVALID')
  }
  if ((scope.toolName === 'edit_file' && scope.operation !== 'edit') || (scope.toolName === 'write_file' && scope.operation !== 'write') ||
    (scope.toolName === 'grep' && scope.operation !== 'search') || (scope.toolName === 'list_work_dirs' && scope.operation !== 'list')) throw new Error('REVIEW_SCOPE_CAPABILITY_INVALID')
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

/**
 * In-memory scope index backed by bounded grants; the host still runs current facts, policy, and final checks per call.
 */
export class ReviewScopeCache {
  private readonly sessionSecrets = new Map<string, Buffer>()
  private readonly entries = new Map<string, ReviewScopeEntry>()
  private readonly scopes = new Map<string, ReviewScopeCandidate>()
  private readonly maxEntriesPerSession: number
  private readonly maxEntriesTotal: number
  private readonly maxEntryBytes: number
  private readonly randomBytes: (size: number) => Buffer
  private readonly now: () => number
  private readonly grantStore: ReviewScopeGrantStore | undefined
  private generation = 0

  constructor(options: ReviewScopeCacheOptions = {}) {
    this.maxEntriesPerSession = options.maxEntriesPerSession ?? DEFAULT_MAX_PER_SESSION
    this.maxEntriesTotal = options.maxEntriesTotal ?? DEFAULT_MAX_TOTAL
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.randomBytes = options.randomBytes ?? randomBytes
    this.now = options.now ?? Date.now
    this.grantStore = options.grantStore
  }

  candidateDigest(scope: ReviewScopeCandidate): string {
    validateCandidate(scope)
    if (scope.toolName === 'grep' && !isGrepRootEligible(scope.objects[0]!.value)) throw new Error('REVIEW_SCOPE_GREP_ROOT_INVALID')
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
      subjectId: scope.subjectId,
      authorizationDomain: scope.authorizationDomain,
      capability: scope.toolName === 'grep' ? 'grep' : scope.toolName === 'list_work_dirs' ? 'list-work-dirs' : 'file-write',
      objects,
      environment: scope.environment,
      policyVersion: scope.policyVersion,
      ...(scope.toolName === 'grep' ? { exactParameters: scope.exactParameters } : {})
    })
    return createHmac('sha256', secret).update(canonical).digest('hex')
  }

  /** A grant is accepted only when the reviewer echoes the exact host-created candidate token. */
  grant(input: { scope: ReviewScopeCandidate; source: ReviewScopeSource; scopeCandidateDigest: string; lifetime?: ReviewScopeLifetime }): boolean {
    const expected = this.candidateDigest(input.scope)
    if (!HASH_PATTERN.test(input.scopeCandidateDigest) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.scopeCandidateDigest, 'hex'))) return false
    const key = sessionKey(input.scope.lane, input.scope.sessionId)
    const digest = expected
    const state: ReviewScopeState = 'active'
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ digest, key, source: input.source, state, generation: this.generation + 1 }))
    if (estimatedBytes > this.maxEntryBytes) return false
    if (this.entries.has(digest)) return false
    if (!this.makeRoom(key)) return false
    if (this.grantStore && !this.grantStore.grant({ ...this.storeIdentity(input.scope, input.source), lifetime: input.lifetime ?? input.scope.approvalLifetime ?? this.grantStore.getDefaultLifetime() })) return false
    this.entries.set(digest, {
      digest,
      sessionKey: key,
      source: input.source,
      state,
      generation: ++this.generation,
      touchedAt: this.now()
    })
    this.scopes.set(digest, input.scope)
    return true
  }

  /** Register only a host-issued, reviewer-echoed opaque candidate digest. */
  grantDigest(input: { lane: ReviewScopeLane; sessionId: string; source: ReviewScopeSource; scopeCandidateDigest: string; scope?: ReviewScopeCandidate; lifetime?: ReviewScopeLifetime }): boolean {
    const digest = input.scopeCandidateDigest
    if (!HASH_PATTERN.test(digest) || !input.sessionId.trim()) return false
    const key = sessionKey(input.lane, input.sessionId)
    if (!this.sessionSecrets.has(key)) return false
    const state: ReviewScopeState = 'active'
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ digest, key, source: input.source, state, generation: this.generation + 1 }))
    if (estimatedBytes > this.maxEntryBytes || this.entries.has(digest) || !this.makeRoom(key)) return false
    if (this.grantStore && input.scope && !this.grantStore.grant({ ...this.storeIdentity(input.scope, input.source), lifetime: input.lifetime ?? input.scope.approvalLifetime ?? this.grantStore.getDefaultLifetime() })) return false
    this.entries.set(digest, { digest, sessionKey: key, source: input.source, state, generation: ++this.generation, touchedAt: this.now() })
    if (input.scope) this.scopes.set(digest, input.scope)
    return true
  }

  lookup(scope: ReviewScopeCandidate): ReviewScopeEntryView | null {
    let digest: string
    try { digest = this.candidateDigest(scope) } catch { return null }
    let entry = this.entries.get(digest)
    if (entry && !this.isCachedEntryValid(entry)) entry = undefined
    let inheritedParentScope: ReviewScopeEntryView['inheritedParentScope']
    if (!entry && scope.toolName === 'grep') {
      const key = sessionKey(scope.lane, scope.sessionId)
      const parent = [...this.entries.values()]
        .filter((candidate) => candidate.sessionKey === key && candidate.state === 'active' && candidate.source === 'user')
        .filter((candidate) => this.isCachedEntryValid(candidate))
        .sort((a, b) => b.touchedAt - a.touchedAt || b.generation - a.generation)
        .map((candidate) => this.scopes.get(candidate.digest))
        .find((candidate): candidate is ReviewScopeCandidate => Boolean(candidate && candidate.toolName === 'grep' && canInheritGrepRoot(candidate, scope)))
      if (parent) {
        const query = parent.exactParameters as { ignoreDigest?: unknown; engine?: unknown; engineFingerprint?: unknown; extraExcludeDirNames?: unknown }
        if (typeof query.ignoreDigest === 'string' && (query.engine === 'ripgrep' || query.engine === 'walk') && typeof query.engineFingerprint === 'string') inheritedParentScope = {
          root: parent.objects[0]!.value,
          ignoreDigest: query.ignoreDigest,
          engine: query.engine,
          engineFingerprint: query.engineFingerprint,
          extraExcludeDirNames: Array.isArray(query.extraExcludeDirNames) ? query.extraExcludeDirNames.filter((name): name is string => typeof name === 'string') : []
        }
        const parentEntry = [...this.entries.values()].find((candidate) => this.scopes.get(candidate.digest) === parent)
        if (parentEntry) {
          parentEntry.touchedAt = this.now()
          return Object.freeze({ ...this.toView(parentEntry), ...(inheritedParentScope ? { inheritedParentScope } : {}) })
        }
      }
    }
    if (!entry && this.grantStore) {
      const identity = this.storeIdentity(scope, 'agent')
      const userIdentity = { ...identity, source: 'user' as const }
      const durable = this.grantStore.lookup(identity) ?? this.grantStore.lookup(userIdentity)
      if (durable) {
        const key = sessionKey(scope.lane, scope.sessionId)
        if (this.makeRoom(key)) {
          entry = { digest, sessionKey: key, source: durable.source, state: 'active', generation: ++this.generation, touchedAt: this.now() }
          this.entries.set(digest, entry)
          this.scopes.set(digest, scope)
        }
      }
      if (!entry && scope.toolName === 'grep') {
        const ancestor = this.grantStore.lookupGrepAncestor(userIdentity) ?? this.grantStore.lookupGrepAncestor(identity)
        const parentScope = ancestor?.scope as { objects?: Array<{ role?: string; value?: string }>; query?: { ignoreDigest?: unknown; engine?: unknown; engineFingerprint?: unknown; extraExcludeDirNames?: unknown } } | undefined
        const root = parentScope?.objects?.find((object) => object.role === 'root')?.value
        const ignoreDigest = parentScope?.query?.ignoreDigest
        const engine = parentScope?.query?.engine
        const engineFingerprint = parentScope?.query?.engineFingerprint
        if (ancestor && typeof root === 'string' && typeof ignoreDigest === 'string' &&
          (engine === 'ripgrep' || engine === 'walk') && typeof engineFingerprint === 'string') {
          return Object.freeze({ source: ancestor.source, state: 'active', generation: ++this.generation,
            inheritedParentScope: { root, ignoreDigest,
              engine: engine as 'ripgrep' | 'walk',
              engineFingerprint,
              extraExcludeDirNames: Array.isArray(parentScope?.query?.extraExcludeDirNames)
                ? parentScope?.query?.extraExcludeDirNames.filter((name): name is string => typeof name === 'string') ?? [] : [] } })
        }
      }
    }
    if (!entry || entry.state !== 'active') return null
    entry.touchedAt = this.now()
    return Object.freeze({ ...this.toView(entry), ...(inheritedParentScope ? { inheritedParentScope } : {}) })
  }

  state(scope: ReviewScopeCandidate): ReviewScopeEntryView | null {
    let digest: string
    try { digest = this.candidateDigest(scope) } catch { return null }
    const entry = this.entries.get(digest)
    return entry ? this.toView(entry) : null
  }

  revoke(scope: ReviewScopeCandidate): boolean {
    let digest: string
    try { digest = this.candidateDigest(scope) } catch { return false }
    const entry = this.entries.get(digest)
    const memoryRevoked = Boolean(entry)
    if (entry) this.revokeEntry(entry)
    return (this.grantStore?.revoke(this.storeIdentity(scope, 'agent')) ?? false) ||
      (this.grantStore?.revoke({ ...this.storeIdentity(scope, 'agent'), source: 'user' }) ?? false) || memoryRevoked
  }

  clearSession(lane: ReviewScopeLane, sessionId: string): void {
    this.grantStore?.clearSession(lane, sessionId)
    const key = sessionKey(lane, sessionId)
    this.sessionSecrets.get(key)?.fill(0)
    this.sessionSecrets.delete(key)
    for (const [digest, entry] of this.entries) {
      if (entry.sessionKey === key) {
        entry.generation = ++this.generation
        this.entries.delete(digest)
        this.scopes.delete(digest)
      }
    }
  }

  clearAll(): void {
    for (const secret of this.sessionSecrets.values()) secret.fill(0)
    this.sessionSecrets.clear()
    for (const entry of this.entries.values()) entry.generation = ++this.generation
    this.entries.clear()
    this.scopes.clear()
  }

  get size(): number { return this.entries.size }

  clearPersistentGrants(): boolean { return this.grantStore?.clearAll() ?? true }

  clearDeletedSession(sessionId: string): void {
    for (const lane of ['desktop', 'feishu', 'wechat'] as const) this.clearSession(lane, sessionId)
    this.grantStore?.clearSessionId(sessionId)
  }

  getDefaultLifetime(): ReviewScopeLifetime { return this.grantStore?.getDefaultLifetime() ?? 'session' }

  setDefaultLifetime(lifetime: ReviewScopeLifetime): boolean { return this.grantStore?.setDefaultLifetime(lifetime) ?? lifetime === 'session' }

  private storeIdentity(scope: ReviewScopeCandidate, source: ReviewScopeSource): ReviewScopeGrantIdentity {
    const capability = scope.toolName === 'grep' ? 'grep' : scope.toolName === 'list_work_dirs' ? 'list-work-dirs' : 'file-write'
    const objects = [...scope.objects].sort((a, b) => a.role.localeCompare(b.role) || a.value.localeCompare(b.value))
    const safeScope = capability === 'file-write'
      ? { workDir: scope.environment, objects }
      : capability === 'grep' ? { workDir: scope.environment, objects, query: scope.exactParameters }
        : { disclosureDigest: objects[0]?.value }
    return {
      lane: scope.lane, subjectId: scope.subjectId,
      domain: scope.lane === 'desktop' ? 'desktop' : 'im',
      policyRevision: scope.authorizationDomain.revision, policyEpoch: scope.authorizationDomain.epoch,
      policyVersion: scope.policyVersion, capability, source, scope: safeScope, sessionId: scope.sessionId
    }
  }

  /** final-check: the grant store owns expiry and revocation; memory entries are indexes, never authority. */
  private isCachedEntryValid(entry: ReviewScopeEntry): boolean {
    if (!this.grantStore) return true
    const scope = this.scopes.get(entry.digest)
    if (!scope) {
      this.revokeEntry(entry)
      return false
    }
    if (this.grantStore.lookup(this.storeIdentity(scope, entry.source))) return true
    this.revokeEntry(entry)
    return false
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
    entry.generation = ++this.generation
    this.entries.delete(entry.digest)
    this.scopes.delete(entry.digest)
  }

  private toView(entry: ReviewScopeEntry): ReviewScopeEntryView {
    return Object.freeze({ source: entry.source, state: entry.state, generation: entry.generation })
  }
}
