import type { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { runInTransaction } from '../database/transaction'
import { SCHEMA_META_KEYS } from '../database/schema'
import type { ReviewScopeLane, ReviewScopeSource } from './reviewScopeCache'
import { isGrepSubtreeSemanticallyContained } from '../tools/grepScope'

export type ReviewScopeLifetime = 'session' | 'process' | '24h' | '7d'
export type ReviewScopeDomain = 'desktop' | 'im'

export interface ReviewScopeGrantIdentity {
  readonly lane: ReviewScopeLane
  readonly subjectId: string
  readonly domain: ReviewScopeDomain
  readonly policyRevision: number
  readonly policyEpoch: number
  readonly policyVersion: string
  readonly capability: 'file-read' | 'file-write' | 'grep' | 'list-work-dirs'
  readonly source: ReviewScopeSource
  /** Host-generated, bounded permission scope. Never pass messages, file bodies, or tool receipts. */
  readonly scope: unknown
  readonly sessionId: string
}

export interface ReviewScopeGrantView {
  readonly source: ReviewScopeSource
  readonly lifetime: ReviewScopeLifetime
  readonly issuedAtMs: number
  readonly expiresAtMs?: number
  /** Host-shaped stored scope, exposed only to the cache for ancestor permit construction. */
  readonly scope?: unknown
}

export interface ReviewScopeGrantStoreOptions {
  readonly now?: () => number
  readonly maxEntries?: number
  readonly maxScopeBytes?: number
}

interface PersistentGrantRow extends ReviewScopeGrantView {
  readonly id: number
}

const LIFETIMES: readonly ReviewScopeLifetime[] = ['session', 'process', '24h', '7d']
const DURABLE_MS: Readonly<Record<'24h' | '7d', number>> = { '24h': 86_400_000, '7d': 604_800_000 }
const DEFAULT_MAX_ENTRIES = 4096
const DEFAULT_MAX_SCOPE_BYTES = 16 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalJson(value: unknown, seen = new Set<object>()): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null
  if (Array.isArray(value) || isRecord(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    let result: string | null
    if (Array.isArray(value)) {
      const values = value.map((item) => canonicalJson(item, seen))
      result = values.some((entry) => entry === null) ? null : `[${values.join(',')}]`
    } else {
      const entries: string[] = []
      result = null
      for (const key of Object.keys(value).sort()) {
        const encoded = canonicalJson(value[key], seen)
        if (encoded === null) { result = null; break }
        entries.push(`${JSON.stringify(key)}:${encoded}`)
        result = `{${entries.join(',')}}`
      }
      if (Object.keys(value).length === 0) result = '{}'
    }
    seen.delete(value)
    return result
  }
  return null
}

function validIdentity(input: ReviewScopeGrantIdentity): boolean {
  return ['desktop', 'feishu', 'wechat'].includes(input.lane) && input.subjectId.trim().length > 0 &&
    ['desktop', 'im'].includes(input.domain) && Number.isSafeInteger(input.policyRevision) && input.policyRevision >= 0 &&
    Number.isSafeInteger(input.policyEpoch) && input.policyEpoch >= 0 && input.policyVersion.trim().length > 0 &&
    ['file-read', 'file-write', 'grep', 'list-work-dirs'].includes(input.capability) &&
    ['agent', 'user'].includes(input.source) && input.sessionId.trim().length > 0 &&
    ((input.lane === 'desktop' && input.domain === 'desktop') || (input.lane !== 'desktop' && input.domain === 'im'))
}

function volatileKey(identity: ReviewScopeGrantIdentity, scopeJson: string, lifetime: 'session' | 'process'): string {
  return JSON.stringify([
    identity.lane, identity.subjectId, identity.domain, identity.policyRevision, identity.policyEpoch,
    identity.policyVersion, identity.capability, identity.source, scopeJson,
    lifetime === 'session' ? identity.sessionId : null
  ])
}

/**
 * facts / policy / final-check boundary: stores only host-normalized authorization scope and identity.
 * It owns approval lifetime; execution results and permits cannot activate, extend, or restore grants.
 */
export class ReviewScopeGrantStore {
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxScopeBytes: number
  private readonly volatile = new Map<string, ReviewScopeGrantView>()
  private processStartedAt = 0

  constructor(private readonly db: DatabaseSync, options: ReviewScopeGrantStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.processStartedAt = this.now()
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxScopeBytes = options.maxScopeBytes ?? DEFAULT_MAX_SCOPE_BYTES
    this.ensureMetadata()
  }

  getDefaultLifetime(): ReviewScopeLifetime {
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.reviewScopeDefaultLifetime) as { value: string } | undefined
    return LIFETIMES.includes(row?.value as ReviewScopeLifetime) ? row!.value as ReviewScopeLifetime : 'session'
  }

  setDefaultLifetime(lifetime: ReviewScopeLifetime): boolean {
    if (!LIFETIMES.includes(lifetime)) return false
    try {
      runInTransaction(this.db, () => {
        this.db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(SCHEMA_META_KEYS.reviewScopeDefaultLifetime, lifetime)
      })
      return true
    } catch { return false }
  }

  grant(input: ReviewScopeGrantIdentity & { readonly lifetime: ReviewScopeLifetime }): boolean {
    if (!validIdentity(input) || !LIFETIMES.includes(input.lifetime)) return false
    if (!this.isCurrentEpoch(input.domain, input.policyEpoch)) return false
    const scopeJson = canonicalJson(input.scope)
    if (scopeJson === null || Buffer.byteLength(scopeJson, 'utf8') > this.maxScopeBytes) return false
    if (input.lifetime === 'session' || input.lifetime === 'process') {
      const now = this.now()
      const key = volatileKey(input, scopeJson, input.lifetime)
      this.volatile.set(key, Object.freeze({ source: input.source, lifetime: input.lifetime, issuedAtMs: now, scope: input.scope }))
      this.enforceVolatileCapacity()
      return true
    }
    const now = this.commitTime()
    if (now === null) return false
    const lifetimeMs = DURABLE_MS[input.lifetime]
    const expiresAtMs = now + lifetimeMs
    if (!Number.isSafeInteger(expiresAtMs)) return false
    try {
      runInTransaction(this.db, () => {
        this.db.prepare('DELETE FROM review_scope_grants WHERE expires_at_ms <= ? OR domain = ? AND (policy_revision <> ? OR policy_epoch <> ?)')
          .run(now, input.domain, input.policyRevision, input.policyEpoch)
        this.db.prepare(`INSERT INTO review_scope_grants(format_version,lane,subject_id,domain,policy_revision,policy_epoch,
          policy_version,capability,source,scope_json,lifetime,issued_at_ms,expires_at_ms)
          VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(domain,lane,subject_id,policy_revision,policy_epoch,policy_version,capability,source,lifetime,scope_json)
          DO UPDATE SET issued_at_ms=excluded.issued_at_ms,expires_at_ms=excluded.expires_at_ms`)
          .run(input.lane, input.subjectId, input.domain, input.policyRevision, input.policyEpoch, input.policyVersion,
            input.capability, input.source, scopeJson, input.lifetime, now, expiresAtMs)
        this.db.prepare(`DELETE FROM review_scope_grants WHERE id IN (
          SELECT id FROM review_scope_grants ORDER BY issued_at_ms ASC,id ASC LIMIT MAX(0,(SELECT COUNT(*) FROM review_scope_grants)-?)
        )`).run(this.maxEntries)
      })
      return true
    } catch { return false }
  }

  lookup(input: ReviewScopeGrantIdentity): ReviewScopeGrantView | null {
    if (!validIdentity(input)) return null
    if (!this.isCurrentEpoch(input.domain, input.policyEpoch)) return null
    const scopeJson = canonicalJson(input.scope)
    if (scopeJson === null || Buffer.byteLength(scopeJson, 'utf8') > this.maxScopeBytes) return null
    const sessionGrant = this.volatile.get(volatileKey(input, scopeJson, 'session'))
    if (sessionGrant) return sessionGrant
    const processGrant = this.volatile.get(volatileKey(input, scopeJson, 'process'))
    if (processGrant) return processGrant
    const now = this.commitTime()
    if (now === null) return null
    try {
      const row = this.db.prepare(`SELECT id,source,lifetime,issued_at_ms,expires_at_ms,scope_json FROM review_scope_grants
        WHERE domain=? AND lane=? AND subject_id=? AND policy_revision=? AND policy_epoch=? AND policy_version=? AND capability=? AND scope_json=?
          AND expires_at_ms>? ORDER BY issued_at_ms DESC,id DESC LIMIT 1`)
        .get(input.domain, input.lane, input.subjectId, input.policyRevision, input.policyEpoch, input.policyVersion,
          input.capability, scopeJson, now) as { id: number; source: ReviewScopeSource; lifetime: '24h' | '7d'; issued_at_ms: number; expires_at_ms: number; scope_json: string } | undefined
      if (!row) return null
      return Object.freeze({ source: row.source, lifetime: row.lifetime, issuedAtMs: row.issued_at_ms, expiresAtMs: row.expires_at_ms, scope: JSON.parse(row.scope_json) as unknown })
    } catch { return null }
  }

  /** G-01 subset check is deliberately limited to host-shaped grep scopes; path containment is component based. */
  lookupGrepAncestor(input: ReviewScopeGrantIdentity): ReviewScopeGrantView | null {
    if (input.capability !== 'grep' || !validIdentity(input) || !this.isCurrentEpoch(input.domain, input.policyEpoch)) return null
    const currentJson = canonicalJson(input.scope)
    if (!currentJson) return null
    const current = JSON.parse(currentJson) as { workDir?: unknown; objects?: unknown; query?: unknown }
    const currentRoot = scopeRoot(current)
    if (!currentRoot) return null
    const containsCurrentScope = (parent: { workDir?: unknown; objects?: unknown; query?: unknown }): boolean => {
      const parentRoot = scopeRoot(parent)
      if (!parentRoot || parent.workDir !== current.workDir || !sameGrepQuery(parent.query, current.query)) return false
      const relative = path.relative(parentRoot, currentRoot)
      const query = current.query && typeof current.query === 'object' ? current.query as { includeIgnored?: unknown; glob?: unknown; ignoreDigest?: unknown } : {}
      return (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) &&
        typeof query.ignoreDigest === 'string' && /^[a-f0-9]{64}$/.test(query.ignoreDigest) &&
        isGrepSubtreeSemanticallyContained(parentRoot, currentRoot, {
          includeIgnored: query.includeIgnored === true,
          ...(typeof query.glob === 'string' ? { glob: query.glob } : {})
        })
    }
    // Volatile session/process grants use the same scope proof as durable grants.
    // Session grants stay within their issuing session; process grants intentionally cross sessions.
    for (const [key, grant] of this.volatile) {
      let parts: unknown[]
      try { parts = JSON.parse(key) as unknown[] } catch { continue }
      if (parts[0] !== input.lane || parts[1] !== input.subjectId || parts[2] !== input.domain ||
        parts[3] !== input.policyRevision || parts[4] !== input.policyEpoch || parts[5] !== input.policyVersion ||
        parts[6] !== 'grep' || parts[7] !== input.source ||
        (grant.lifetime === 'session' && parts[9] !== input.sessionId) || !grant.scope) continue
      const parent = grant.scope as { workDir?: unknown; objects?: unknown; query?: unknown }
      if (containsCurrentScope(parent)) return grant
    }
    const now = this.commitTime()
    if (now === null) return null
    try {
      const rows = this.db.prepare(`SELECT id,source,lifetime,issued_at_ms,expires_at_ms,scope_json FROM review_scope_grants
        WHERE domain=? AND lane=? AND subject_id=? AND policy_revision=? AND policy_epoch=? AND policy_version=?
          AND capability='grep' AND source=? AND expires_at_ms>? ORDER BY issued_at_ms DESC,id DESC`)
        .all(input.domain, input.lane, input.subjectId, input.policyRevision, input.policyEpoch, input.policyVersion, input.source, now) as
        Array<{ id: number; source: ReviewScopeSource; lifetime: '24h' | '7d'; issued_at_ms: number; expires_at_ms: number; scope_json: string }>
      for (const row of rows) {
        const parent = JSON.parse(row.scope_json) as { workDir?: unknown; objects?: unknown; query?: unknown }
        if (containsCurrentScope(parent)) {
          return Object.freeze({ source: row.source, lifetime: row.lifetime, issuedAtMs: row.issued_at_ms, expiresAtMs: row.expires_at_ms, scope: parent })
        }
      }
      return null
    } catch { return null }
  }

  revoke(input: ReviewScopeGrantIdentity): boolean {
    if (!validIdentity(input)) return false
    const scopeJson = canonicalJson(input.scope)
    if (scopeJson === null) return false
    const before = this.volatile.size
    this.volatile.delete(volatileKey(input, scopeJson, 'session'))
    this.volatile.delete(volatileKey(input, scopeJson, 'process'))
    try {
      const result = this.db.prepare(`DELETE FROM review_scope_grants WHERE domain=? AND lane=? AND subject_id=?
        AND policy_revision=? AND policy_epoch=? AND policy_version=? AND capability=? AND scope_json=?`)
        .run(input.domain, input.lane, input.subjectId, input.policyRevision, input.policyEpoch, input.policyVersion, input.capability, scopeJson)
      return Number(result.changes) > 0 || before !== this.volatile.size
    } catch { return before !== this.volatile.size }
  }

  clearSession(lane: ReviewScopeLane, sessionId: string): void {
    for (const key of this.volatile.keys()) {
      try {
        const parsed = JSON.parse(key) as unknown[]
        if (parsed[0] === lane && parsed[9] === sessionId) this.volatile.delete(key)
      } catch { /* internal keys are generated by this class */ }
    }
  }

  clearSessionId(sessionId: string): void {
    this.clearSession('desktop', sessionId)
    this.clearSession('feishu', sessionId)
    this.clearSession('wechat', sessionId)
  }

  clearAll(): boolean {
    try {
      runInTransaction(this.db, () => {
        this.db.prepare('DELETE FROM review_scope_grants').run()
        for (const domain of ['desktop', 'im'] as const) {
          this.db.prepare(`INSERT INTO policy_authorization_epochs(domain,epoch) VALUES(?,1)
            ON CONFLICT(domain) DO UPDATE SET epoch=policy_authorization_epochs.epoch+1`).run(domain)
        }
      })
      this.volatile.clear()
      return true
    } catch { return false }
  }

  invalidateDomain(domain: ReviewScopeDomain): boolean {
    try {
      runInTransaction(this.db, () => { this.db.prepare('DELETE FROM review_scope_grants WHERE domain=?').run(domain) })
      return true
    } catch { return false }
  }

  private ensureMetadata(): void {
    const now = this.now()
    runInTransaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO schema_meta(key,value) VALUES(?,?)').run(SCHEMA_META_KEYS.reviewScopeDefaultLifetime, 'session')
      const floorRow = this.db.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.reviewScopeWallFloorMs) as { value: string } | undefined
      const validFloor = floorRow && /^(?:0|[1-9]\d*)$/.test(floorRow.value) && Number.isSafeInteger(Number(floorRow.value))
      if (!validFloor) {
        const hasGrants = this.db.prepare('SELECT 1 FROM review_scope_grants LIMIT 1').get() !== undefined
        if (hasGrants) this.db.prepare('DELETE FROM review_scope_grants').run()
        this.db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(SCHEMA_META_KEYS.reviewScopeWallFloorMs, String(now))
      }
      this.db.prepare('DELETE FROM review_scope_grants WHERE expires_at_ms <= ?').run(now)
    })
  }

  private isCurrentEpoch(domain: ReviewScopeDomain, expectedEpoch: number): boolean {
    try {
      const row = this.db.prepare('SELECT epoch FROM policy_authorization_epochs WHERE domain=?').get(domain) as { epoch: number } | undefined
      return row !== undefined && expectedEpoch === row.epoch
    } catch { return false }
  }

  private commitTime(): number | null {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) return null
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.reviewScopeWallFloorMs) as { value: string } | undefined
    const floor = row && /^(?:0|[1-9]\d*)$/.test(row.value) ? Number(row.value) : null
    if (floor === null) {
      const hasGrants = this.db.prepare('SELECT 1 FROM review_scope_grants LIMIT 1').get() !== undefined
      if (hasGrants) {
        this.db.prepare('DELETE FROM review_scope_grants').run()
        return null
      }
      this.db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(SCHEMA_META_KEYS.reviewScopeWallFloorMs, String(now))
      return now
    }
    if (now < floor) {
      runInTransaction(this.db, () => this.db.prepare('DELETE FROM review_scope_grants').run())
      return null
    }
    if (now > floor) this.db.prepare('UPDATE schema_meta SET value=? WHERE key=?').run(String(now), SCHEMA_META_KEYS.reviewScopeWallFloorMs)
    return now
  }

  private enforceVolatileCapacity(): void {
    while (this.volatile.size > this.maxEntries) this.volatile.delete(this.volatile.keys().next().value as string)
  }
}

function scopeRoot(scope: { objects?: unknown }): string | null {
  if (!Array.isArray(scope.objects) || scope.objects.length !== 1) return null
  const object = scope.objects[0] as { role?: unknown; value?: unknown } | null
  return object?.role === 'root' && typeof object.value === 'string' && path.isAbsolute(object.value) ? object.value : null
}

function sameGrepQuery(parent: unknown, current: unknown): boolean {
  const withoutDigest = (value: unknown): string | null => {
    if (!isRecord(value)) return null
    const { ignoreDigest: _ignoreDigest, ...query } = value
    return canonicalJson(query)
  }
  return withoutDigest(parent) !== null && withoutDigest(parent) === withoutDigest(current)
}
