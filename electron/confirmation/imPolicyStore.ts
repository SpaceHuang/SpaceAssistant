import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../database/transaction'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { isPolicyPackage } from '../../src/shared/policy/policyPackages'

export interface CommitImPolicySnapshotInput {
  expectedRevision?: number
  policyBehaviorVersion: string
  snapshot: unknown
  updatedAt: number
  eventId: string
  beforeAudit?: () => void
  beforeSnapshot?: () => void
  eventKind?: 'policy-snapshot-updated' | 'policy-snapshot-restored' | 'legacy-policy-migrated' | 'policy-behavior-version-switched' | 'policy-behavior-version-rolled-back' | 'policy-behavior-version-reenabled'
  actor?: 'user' | 'system' | 'migration'
  auditMetadata?: Record<string, unknown>
  onCommitted?: (domain: 'desktop' | 'im', revision: number) => void
}

export type CommitImPolicySnapshotResult =
  | { status: 'committed'; revision: number }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'already-migrated'; revision: number }

export interface ReadImPolicySnapshotOptions {
  supportedBehaviorVersions: readonly string[]
}

export interface ImPolicySnapshot {
  domain: 'im'
  policyBehaviorVersion: string
  revision: number
  snapshot: Record<string, unknown>
}

export type PolicyDomain = 'desktop' | 'im' | 'automation'

export interface PolicyBehaviorSnapshot {
  domain: PolicyDomain
  policyBehaviorVersion: string
  revision: number
  snapshot: Record<string, unknown>
}

export interface ImStandardV3ReleaseGate {
  publishedV3Ready: boolean
  fixedRuleSetVerified: boolean
  restrictionMappingVerified: boolean
}

function isCompleteImStandardV3ReleaseGate(gate: ImStandardV3ReleaseGate | undefined): gate is ImStandardV3ReleaseGate {
  return gate?.publishedV3Ready === true && gate.fixedRuleSetVerified === true && gate.restrictionMappingVerified === true
}

export function readPolicyBehaviorSnapshot(
  db: DatabaseSync,
  domain: unknown,
  options: ReadImPolicySnapshotOptions
): PolicyBehaviorSnapshot {
  if (domain !== 'desktop' && domain !== 'im' && domain !== 'automation') throw new Error('POLICY_DOMAIN_UNSUPPORTED')
  const row = db.prepare(`SELECT domain,policy_behavior_version,revision,snapshot_json
    FROM policy_behavior_snapshots WHERE domain=?`).get(domain) as {
      domain: string; policy_behavior_version: string; revision: number; snapshot_json: string
    } | undefined
  if (!row || row.domain !== domain) throw new Error(`${domain.toUpperCase()} policy snapshot is missing`)
  if (!row.policy_behavior_version || !options.supportedBehaviorVersions.includes(row.policy_behavior_version)) {
    throw new Error(`Unknown policy behavior version: ${row.policy_behavior_version}`)
  }
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid IM policy revision')
  let snapshot: unknown
  try {
    snapshot = JSON.parse(row.snapshot_json)
  } catch {
    throw new Error('Invalid IM policy snapshot JSON')
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid IM policy snapshot data')
  if (domain === 'im') validateAutomaticMigrationSuppression(snapshot as Record<string, unknown>)
  return { domain, policyBehaviorVersion: row.policy_behavior_version, revision: row.revision, snapshot: snapshot as Record<string, unknown> }
}

const VALID_IM_BEHAVIOR_VERSION_IDS = new Set(['im-v1.6', 'im-standard-v2', 'im-standard-v3'])
const IM_STANDARD_V3_BEHAVIOR_VERSION = 'im-standard-v3'
const IM_MIGRATION_SUPPRESSION_FIELD = 'automaticMigrationSuppressedVersions'

function validateAutomaticMigrationSuppression(snapshot: Record<string, unknown>): string[] | undefined {
  if (!Object.hasOwn(snapshot, IM_MIGRATION_SUPPRESSION_FIELD)) return undefined
  const value = snapshot[IM_MIGRATION_SUPPRESSION_FIELD]
  if (!Array.isArray(value) || value.some((version) => typeof version !== 'string' || !VALID_IM_BEHAVIOR_VERSION_IDS.has(version))) {
    throw new Error('Invalid IM automatic migration suppression field')
  }
  if (new Set(value).size !== value.length) throw new Error('Invalid IM automatic migration suppression field')
  return value as string[]
}

/** migration qualification: validate snapshot-local evidence shared by startup migration and explicit re-enable. */
export function validateImStandardV3SnapshotQualification(snapshot: Record<string, unknown>): 'unresolved-restrictions' | 'invalid-package' | undefined {
  const humanRequired = snapshot.humanRequired
  const unresolvedDifferences = snapshot.unresolvedDifferences
  if ((humanRequired !== undefined && typeof humanRequired !== 'boolean') || humanRequired === true ||
    (unresolvedDifferences !== undefined && (!Array.isArray(unresolvedDifferences) || unresolvedDifferences.length > 0))) {
    return 'unresolved-restrictions'
  }
  if (Object.hasOwn(snapshot, 'selectedPackage') && !isPolicyPackage(snapshot.selectedPackage)) return 'invalid-package'
  if (Object.hasOwn(snapshot, 'legacySelectedPackages')) {
    const value = snapshot.legacySelectedPackages
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid-package'
    const packages = value as Record<string, unknown>
    if (Object.keys(packages).length !== 2 || !Object.hasOwn(packages, 'wechat') || !Object.hasOwn(packages, 'feishu') ||
      Object.values(packages).some((pkg) => !isPolicyPackage(pkg))) return 'invalid-package'
  }
  return undefined
}

interface ImSuppressionMutation { operation: 'add' | 'remove'; behaviorVersion: string }

export function readImPolicySnapshot(db: DatabaseSync, options: ReadImPolicySnapshotOptions): ImPolicySnapshot {
  return readPolicyBehaviorSnapshot(db, 'im', options) as ImPolicySnapshot
}

export function commitDesktopPolicySnapshot(db: DatabaseSync, input: Omit<CommitImPolicySnapshotInput, 'eventKind'>): CommitImPolicySnapshotResult {
  if (!input.policyBehaviorVersion.trim()) throw new Error('policyBehaviorVersion is required')
  if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) throw new Error('updatedAt must be a non-negative integer')
  const result = runInTransaction(db, () => {
    const current = db.prepare("SELECT revision FROM policy_behavior_snapshots WHERE domain='desktop'").get() as { revision: number } | undefined
    const currentRevision = current?.revision ?? 0
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) return { status: 'conflict', currentRevision } as const
    input.beforeSnapshot?.()
    const nextRevision = currentRevision + 1
    const previous = db.prepare("SELECT policy_behavior_version,snapshot_json,updated_at FROM policy_behavior_snapshots WHERE domain='desktop'")
      .get() as { policy_behavior_version: string; snapshot_json: string; updated_at: number } | undefined
    if (previous) db.prepare(`INSERT OR IGNORE INTO policy_behavior_snapshot_history(history_id,domain,policy_behavior_version,snapshot_json,archived_at)
      VALUES(?,?,?,?,?)`).run(`desktop:${currentRevision}`, 'desktop', previous.policy_behavior_version, previous.snapshot_json, previous.updated_at)
    db.prepare(`INSERT INTO policy_behavior_snapshots(domain,policy_behavior_version,revision,snapshot_json,updated_at)
      VALUES('desktop',?,?,?,?) ON CONFLICT(domain) DO UPDATE SET policy_behavior_version=excluded.policy_behavior_version,
      revision=excluded.revision,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
      .run(input.policyBehaviorVersion, nextRevision, JSON.stringify(input.snapshot), input.updatedAt)
    db.prepare(`INSERT INTO policy_authorization_epochs(domain,epoch) VALUES('desktop',1)
      ON CONFLICT(domain) DO UPDATE SET epoch=policy_authorization_epochs.epoch+1`).run()
    input.beforeAudit?.()
    db.prepare('INSERT INTO policy_audit_events(event_id,domain,event_json) VALUES(?,?,?)')
      .run(input.eventId, 'desktop', JSON.stringify({ kind: 'policy-snapshot-updated', policyDomain: 'desktop',
        actor: input.actor ?? 'user', policyBehaviorVersion: input.policyBehaviorVersion,
        previousRevision: currentRevision, policyRevision: nextRevision, updatedAt: input.updatedAt, ...input.auditMetadata }))
    return { status: 'committed', revision: nextRevision } as const
  })
  if (result.status === 'committed') input.onCommitted?.('desktop', result.revision)
  return result
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName) !== undefined
}

export function commitImPolicySnapshot(db: DatabaseSync, input: CommitImPolicySnapshotInput): CommitImPolicySnapshotResult {
  if (input.policyBehaviorVersion === IM_STANDARD_V3_BEHAVIOR_VERSION) {
    throw new Error('IM standard v3 can only be written by a release-gated startup migration or explicit re-enable')
  }
  return commitImPolicySnapshotInternal(db, input)
}

export function commitImPolicySnapshotFromStartupMigration(db: DatabaseSync, input: CommitImPolicySnapshotInput,
  releaseGate: ImStandardV3ReleaseGate): CommitImPolicySnapshotResult {
  if (input.policyBehaviorVersion !== IM_STANDARD_V3_BEHAVIOR_VERSION || !isCompleteImStandardV3ReleaseGate(releaseGate)) {
    throw new Error('IM standard v3 startup migration requires the complete release gate')
  }
  return commitImPolicySnapshotInternal(db, input)
}

function commitImPolicySnapshotInternal(db: DatabaseSync, input: CommitImPolicySnapshotInput, suppressionMutation?: ImSuppressionMutation): CommitImPolicySnapshotResult {
  if (!input.policyBehaviorVersion.trim()) throw new Error('policyBehaviorVersion is required')
  if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) throw new Error('updatedAt must be a non-negative integer')
  const result = runInTransaction(db, () => {
    const current = db.prepare("SELECT revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get() as { revision: number; snapshot_json: string } | undefined
    const currentRevision = current?.revision ?? 0
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      return { status: 'conflict', currentRevision } as const
    }
    let currentSnapshot: Record<string, unknown> = {}
    if (current) {
      let parsed: unknown
      try { parsed = JSON.parse(current.snapshot_json) } catch { throw new Error('Invalid IM policy snapshot JSON') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid IM policy snapshot data')
      currentSnapshot = parsed as Record<string, unknown>
      validateAutomaticMigrationSuppression(currentSnapshot)
    }
    input.beforeSnapshot?.()
    const nextRevision = currentRevision + 1
    const previous = db.prepare(`SELECT policy_behavior_version,snapshot_json,updated_at
      FROM policy_behavior_snapshots WHERE domain='im'`).get() as {
        policy_behavior_version: string; snapshot_json: string; updated_at: number
      } | undefined
    if (previous) {
      db.prepare(`INSERT OR IGNORE INTO policy_behavior_snapshot_history(history_id,domain,policy_behavior_version,snapshot_json,archived_at)
        VALUES(?,?,?,?,?)`).run(`im:${currentRevision}`, 'im', previous.policy_behavior_version, previous.snapshot_json, previous.updated_at)
    }
    if (!input.snapshot || typeof input.snapshot !== 'object' || Array.isArray(input.snapshot)) {
      throw new Error('Invalid IM policy snapshot data')
    }
    const snapshotToWrite: Record<string, unknown> = { ...input.snapshot }
    const currentSuppression = validateAutomaticMigrationSuppression(currentSnapshot)
    if (suppressionMutation) {
      if (!VALID_IM_BEHAVIOR_VERSION_IDS.has(suppressionMutation.behaviorVersion)) throw new Error('Invalid IM behavior version for migration suppression')
      const nextSuppression = new Set(currentSuppression ?? [])
      if (suppressionMutation.operation === 'add') nextSuppression.add(suppressionMutation.behaviorVersion)
      else nextSuppression.delete(suppressionMutation.behaviorVersion)
      snapshotToWrite[IM_MIGRATION_SUPPRESSION_FIELD] = [...nextSuppression]
    } else if (currentSuppression !== undefined) {
      snapshotToWrite[IM_MIGRATION_SUPPRESSION_FIELD] = currentSuppression
    } else {
      delete snapshotToWrite[IM_MIGRATION_SUPPRESSION_FIELD]
    }
    db.prepare(`INSERT INTO policy_behavior_snapshots(domain,policy_behavior_version,revision,snapshot_json,updated_at)
      VALUES('im',?,?,?,?)
      ON CONFLICT(domain) DO UPDATE SET
        policy_behavior_version=excluded.policy_behavior_version,
        revision=excluded.revision,
        snapshot_json=excluded.snapshot_json,
        updated_at=excluded.updated_at`).run(input.policyBehaviorVersion, nextRevision, JSON.stringify(snapshotToWrite), input.updatedAt)
    db.prepare(`INSERT INTO policy_authorization_epochs(domain,epoch) VALUES('im',1)
      ON CONFLICT(domain) DO UPDATE SET epoch=policy_authorization_epochs.epoch+1`).run()
    db.prepare("UPDATE policy_deferred_todos SET status='invalidated' WHERE domain='im' AND status='active'").run()
    db.prepare("UPDATE policy_authorizations SET status='revoked' WHERE domain='im' AND status='active'").run()
    // Fence the production durable approval path in the same transaction. The policy_* helper
    // tables remain a compact audit index; deferred_todos is the dispatcher source of truth.
    if (tableExists(db, 'deferred_resume_requests') && tableExists(db, 'deferred_todos')) {
      const pendingTodos = db.prepare("SELECT todo_id FROM deferred_todos WHERE channel IN ('wechat','feishu') AND state='pending'")
        .all() as Array<{ todo_id: string }>
      for (const { todo_id } of pendingTodos) {
        db.prepare(`INSERT INTO policy_deferred_todos(todo_id,domain,status) VALUES(?,'im','active')
          ON CONFLICT(todo_id) DO UPDATE SET domain='im'`).run(todo_id)
      }
      db.prepare(`UPDATE deferred_resume_requests SET state='invalidated',updated_at=? WHERE state='pending' AND todo_id IN (
        SELECT t.todo_id FROM deferred_todos t WHERE t.channel IN ('wechat','feishu') AND t.state='pending'
      )`).run(input.updatedAt)
      db.prepare("UPDATE deferred_todos SET state='invalidated',updated_at=? WHERE channel IN ('wechat','feishu') AND state='pending'").run(input.updatedAt)
      db.prepare(`UPDATE policy_deferred_todos SET status='invalidated' WHERE domain='im' AND todo_id IN (
        SELECT todo_id FROM deferred_todos WHERE channel IN ('wechat','feishu') AND state='invalidated'
      )`).run()
    }
    input.beforeAudit?.()
    const invalidatedTodos = db.prepare("SELECT todo_id FROM policy_deferred_todos WHERE domain='im' AND status='invalidated' ORDER BY todo_id").all() as Array<{ todo_id: string }>
    db.prepare('INSERT INTO policy_audit_events(event_id,domain,event_json) VALUES(?,?,?)')
      .run(input.eventId, 'im', JSON.stringify({ kind: input.eventKind ?? 'policy-snapshot-updated', eventKind: input.eventKind ?? 'policy-snapshot-updated',
        policyDomain: 'im', actor: input.actor ?? (input.eventKind === 'legacy-policy-migrated' ? 'migration' : input.eventKind === 'policy-snapshot-restored' ? 'system' : 'user'),
        policyBehaviorVersion: input.policyBehaviorVersion, previousRevision: currentRevision, policyRevision: nextRevision,
        invalidatedTodoIds: invalidatedTodos.map(({ todo_id }) => todo_id), updatedAt: input.updatedAt, ...input.auditMetadata }))
    return { status: 'committed', revision: nextRevision } as const
  })
  if (result.status === 'committed') input.onCommitted?.('im', result.revision)
  return result
}

export interface RollbackImPolicyToVersionInput {
  expectedRevision: number
  policyBehaviorVersion: string
  supportedBehaviorVersions: readonly string[]
  updatedAt: number
  eventId: string
  beforeAudit?: () => void
}

/** Internal transaction contract; deliberately not exposed through IPC/UI. */
export function rollbackImPolicyToVersion(db: DatabaseSync, input: RollbackImPolicyToVersionInput): CommitImPolicySnapshotResult {
  if (!VALID_IM_BEHAVIOR_VERSION_IDS.has(input.policyBehaviorVersion) ||
      !input.supportedBehaviorVersions.includes(input.policyBehaviorVersion) || input.policyBehaviorVersion === IM_STANDARD_V3_BEHAVIOR_VERSION) {
    throw new Error('IM rollback target behavior version is unsupported')
  }
  const current = readImPolicySnapshot(db, { supportedBehaviorVersions: [...input.supportedBehaviorVersions, IM_STANDARD_V3_BEHAVIOR_VERSION] })
  return commitImPolicySnapshotInternal(db, {
    expectedRevision: input.expectedRevision,
    policyBehaviorVersion: input.policyBehaviorVersion,
    snapshot: current.snapshot,
    updatedAt: input.updatedAt,
    eventId: input.eventId,
    eventKind: 'policy-behavior-version-rolled-back',
    actor: 'user',
    auditMetadata: { suppressedBehaviorVersion: IM_STANDARD_V3_BEHAVIOR_VERSION },
    beforeAudit: input.beforeAudit
  }, { operation: 'add', behaviorVersion: IM_STANDARD_V3_BEHAVIOR_VERSION })
}

export interface ReenableImStandardV3Input {
  expectedRevision: number
  releaseGate: ImStandardV3ReleaseGate
  updatedAt: number
  eventId: string
  beforeAudit?: () => void
}

/** Internal transaction contract; UI/IPC and production release wiring remain out of scope. */
export function reenableImStandardV3(db: DatabaseSync, input: ReenableImStandardV3Input): CommitImPolicySnapshotResult {
  if (!isCompleteImStandardV3ReleaseGate(input.releaseGate)) throw new Error('IM standard v3 release gate is not satisfied')
  const current = readImPolicySnapshot(db, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
  const qualificationFailure = validateImStandardV3SnapshotQualification(current.snapshot)
  if (qualificationFailure) throw new Error(`IM standard v3 re-enable blocked by ${qualificationFailure}`)
  const suppressed = validateAutomaticMigrationSuppression(current.snapshot) ?? []
  if (!suppressed.includes(IM_STANDARD_V3_BEHAVIOR_VERSION)) throw new Error('IM standard v3 is not migration-suppressed')
  return commitImPolicySnapshotInternal(db, {
    expectedRevision: input.expectedRevision,
    policyBehaviorVersion: IM_STANDARD_V3_BEHAVIOR_VERSION,
    snapshot: { ...current.snapshot, selectedPackage: 'standard' },
    updatedAt: input.updatedAt,
    eventId: input.eventId,
    eventKind: 'policy-behavior-version-reenabled',
    actor: 'user',
    auditMetadata: { removedSuppression: IM_STANDARD_V3_BEHAVIOR_VERSION },
    beforeAudit: input.beforeAudit
  }, { operation: 'remove', behaviorVersion: IM_STANDARD_V3_BEHAVIOR_VERSION })
}

export interface MigrateLegacyImPolicySnapshotInput {
  plan: { status: 'migrate'; domain: 'im'; policyBehaviorVersion: string; snapshot: Record<string, unknown> }
  updatedAt: number
  eventId: string
  beforeCommit?: () => void
}

export function migrateLegacyImPolicySnapshot(db: DatabaseSync, input: MigrateLegacyImPolicySnapshotInput): CommitImPolicySnapshotResult {
  const current = db.prepare("SELECT policy_behavior_version,revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get() as {
    policy_behavior_version: string; revision: number; snapshot_json: string
  } | undefined
  if (!current) throw new Error('Current IM policy snapshot is missing')
  let currentSnapshot: Record<string, unknown>
  try {
    currentSnapshot = JSON.parse(current.snapshot_json) as Record<string, unknown>
  } catch {
    throw new Error('Current IM policy snapshot is corrupt; legacy migration is blocked')
  }
  if (currentSnapshot.legacyMigrationSourceVersion === input.plan.policyBehaviorVersion) {
    return { status: 'already-migrated', revision: current.revision }
  }
  return commitImPolicySnapshot(db, {
    expectedRevision: current.revision,
    policyBehaviorVersion: input.plan.policyBehaviorVersion,
    snapshot: { ...input.plan.snapshot, legacyMigrationSourceVersion: input.plan.policyBehaviorVersion },
    updatedAt: input.updatedAt,
    eventId: input.eventId,
    eventKind: 'legacy-policy-migrated',
    actor: 'migration',
    beforeSnapshot: input.beforeCommit
  })
}

export interface SwitchToCurrentImStandardInput {
  userChoiceConfirmed: boolean
  displayedDiffs: readonly string[]
  updatedAt: number
  eventId: string
}

export function switchToCurrentImStandard(db: DatabaseSync, input: SwitchToCurrentImStandardInput): CommitImPolicySnapshotResult {
  if (input.userChoiceConfirmed !== true || input.displayedDiffs.length === 0 || input.displayedDiffs.some((diff) => !diff.trim())) {
    throw new Error('An explicit user choice after displaying behavior differences is required')
  }
  const current = readImPolicySnapshot(db, { supportedBehaviorVersions: [
    'v1', 'im-v1.6', 'im-standard-v2'
  ] })
  return commitImPolicySnapshot(db, {
    expectedRevision: current.revision,
    policyBehaviorVersion: 'im-standard-v2',
    snapshot: {
      ...current.snapshot,
      selectedPackage: 'standard',
      explicitBehaviorSwitch: true,
      displayedBehaviorDiffs: [...input.displayedDiffs]
    },
    updatedAt: input.updatedAt,
    eventId: input.eventId,
    eventKind: 'policy-behavior-version-switched',
    actor: 'user',
    auditMetadata: { userChoiceConfirmed: true, displayedDiffs: [...input.displayedDiffs] }
  })
}

/** Database-owned adapter for IPC composition. Keeps raw connection access inside confirmation storage. */
export function createImPolicyDatabaseAdapter(appDb: AppDatabase) {
  return Object.freeze({
    readBehavior: (domain: unknown, options: ReadImPolicySnapshotOptions) =>
      readPolicyBehaviorSnapshot(getDbConnection(appDb), domain, options),
    readIm: (options: ReadImPolicySnapshotOptions) => readImPolicySnapshot(getDbConnection(appDb), options),
    commit: (input: CommitImPolicySnapshotInput) => commitImPolicySnapshot(getDbConnection(appDb), input),
    switchToCurrentStandard: (input: SwitchToCurrentImStandardInput) =>
      switchToCurrentImStandard(getDbConnection(appDb), input)
  })
}

export interface RestoreImPolicySnapshotInput {
  historyId: string
  supportedBehaviorVersions: readonly string[]
  updatedAt: number
  eventId: string
}

export function restoreImPolicySnapshot(db: DatabaseSync, input: RestoreImPolicySnapshotInput): CommitImPolicySnapshotResult {
  const history = db.prepare(`SELECT domain,policy_behavior_version,snapshot_json
    FROM policy_behavior_snapshot_history WHERE history_id=?`).get(input.historyId) as {
      domain: string; policy_behavior_version: string; snapshot_json: string
    } | undefined
  if (!history || history.domain !== 'im') throw new Error('IM policy history snapshot is missing')
  if (!history.policy_behavior_version || !input.supportedBehaviorVersions.includes(history.policy_behavior_version)) {
    throw new Error(`Unknown policy behavior version: ${history.policy_behavior_version}`)
  }
  let snapshot: unknown
  try {
    snapshot = JSON.parse(history.snapshot_json)
  } catch {
    throw new Error('Invalid IM policy history snapshot JSON')
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid IM policy history snapshot data')
  const current = readImPolicySnapshot(db, { supportedBehaviorVersions: [
    ...(input.supportedBehaviorVersions), history.policy_behavior_version
  ] })
  const result = commitImPolicySnapshot(db, {
    expectedRevision: current.revision,
    policyBehaviorVersion: history.policy_behavior_version,
    snapshot,
    updatedAt: input.updatedAt,
    eventId: input.eventId,
    eventKind: 'policy-snapshot-restored',
    actor: 'system'
  })
  if (result.status === 'conflict') throw new Error(`Policy revision conflict during recovery: ${result.currentRevision}`)
  return result
}
