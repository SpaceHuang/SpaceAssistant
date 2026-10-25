import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from '../database/transaction'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'

export interface CommitImPolicySnapshotInput {
  expectedRevision?: number
  policyBehaviorVersion: string
  snapshot: unknown
  updatedAt: number
  eventId: string
  beforeAudit?: () => void
  beforeSnapshot?: () => void
  eventKind?: 'policy-snapshot-updated' | 'policy-snapshot-restored' | 'legacy-policy-migrated' | 'policy-behavior-version-switched'
  actor?: 'user' | 'system' | 'migration'
  auditMetadata?: Record<string, unknown>
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
  return { domain, policyBehaviorVersion: row.policy_behavior_version, revision: row.revision, snapshot: snapshot as Record<string, unknown> }
}

export function readImPolicySnapshot(db: DatabaseSync, options: ReadImPolicySnapshotOptions): ImPolicySnapshot {
  return readPolicyBehaviorSnapshot(db, 'im', options) as ImPolicySnapshot
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName) !== undefined
}

export function commitImPolicySnapshot(db: DatabaseSync, input: CommitImPolicySnapshotInput): CommitImPolicySnapshotResult {
  if (!input.policyBehaviorVersion.trim()) throw new Error('policyBehaviorVersion is required')
  if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) throw new Error('updatedAt must be a non-negative integer')
  return runInTransaction(db, () => {
    const current = db.prepare("SELECT revision FROM policy_behavior_snapshots WHERE domain='im'").get() as { revision: number } | undefined
    const currentRevision = current?.revision ?? 0
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      return { status: 'conflict', currentRevision } as const
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
    db.prepare(`INSERT INTO policy_behavior_snapshots(domain,policy_behavior_version,revision,snapshot_json,updated_at)
      VALUES('im',?,?,?,?)
      ON CONFLICT(domain) DO UPDATE SET
        policy_behavior_version=excluded.policy_behavior_version,
        revision=excluded.revision,
        snapshot_json=excluded.snapshot_json,
        updated_at=excluded.updated_at`).run(input.policyBehaviorVersion, nextRevision, JSON.stringify(input.snapshot), input.updatedAt)
    db.prepare(`INSERT INTO policy_authorization_epochs(domain,epoch) VALUES('im',1)
      ON CONFLICT(domain) DO UPDATE SET epoch=policy_authorization_epochs.epoch+1`).run()
    db.prepare("UPDATE policy_deferred_todos SET status='invalidated' WHERE domain='im' AND status='active'").run()
    db.prepare("UPDATE policy_authorizations SET status='revoked' WHERE domain='im' AND status='active'").run()
    // Fence the production durable approval path in the same transaction. The policy_* helper
    // tables remain a compact audit index; deferred_todos is the dispatcher source of truth.
    if (tableExists(db, 'deferred_resume_requests') && tableExists(db, 'deferred_todos')) {
      db.prepare(`UPDATE deferred_resume_requests SET state='invalidated',updated_at=? WHERE state='pending' AND todo_id IN (
        SELECT t.todo_id FROM deferred_todos t WHERE t.channel IN ('wechat','feishu') AND t.state='pending'
      )`).run(input.updatedAt)
      db.prepare("UPDATE deferred_todos SET state='invalidated',updated_at=? WHERE channel IN ('wechat','feishu') AND state='pending'").run(input.updatedAt)
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
