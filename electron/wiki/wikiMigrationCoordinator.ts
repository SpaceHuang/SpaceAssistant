import { createWikiFileStore } from './wikiFileStore'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiMigrationJournal, type WikiMigrationManifest } from './wikiMigrationJournal'
import { scanWikiMigrationPreflight, type WikiMigrationPreflightReport } from './wikiMigrationPreflight'

export interface WikiMigrationChange { objectKind: string; relativePath: string; expectedOldHash: string; expectedOldExists: boolean; newBytes: Buffer }

/** facts / lifecycle invariant: only a confirmed preflight hash may cross the migration barrier. */
export function createWikiMigrationCoordinator(wikiRoot: string) {
  const store = createWikiFileStore(wikiRoot)
  const lifecycle = createWikiLifecycleController(wikiRoot)
  const journal = createWikiMigrationJournal({ store, markRecoveryRequired: (lockHeld) => lifecycle.markRecoveryRequired({ lockHeld }) })
  const preflights = new Map<string, WikiMigrationPreflightReport>()

  return {
    async preflight(): Promise<WikiMigrationPreflightReport> {
      const report = await scanWikiMigrationPreflight(store)
      preflights.clear()
      preflights.set(report.manifestHash, report)
      return structuredClone(report)
    },

    async migrate(input: { preflightHash: string; confirmedPreflightHash: string; crashAfterWriteIndex?: number }): Promise<WikiMigrationManifest> {
      if (!input.preflightHash || input.preflightHash !== input.confirmedPreflightHash) throw new Error('wiki-migration-confirmation-mismatch')
      const report = preflights.get(input.preflightHash)
      if (!report) throw new Error('wiki-migration-preflight-expired')
      if (report.diagnostics.length) throw new Error('wiki-migration-preflight-conflicts')
      const freshReport = await scanWikiMigrationPreflight(store)
      if (freshReport.manifestHash !== input.preflightHash) throw new Error('wiki-migration-preflight-stale')
      const snapshot = await lifecycle.read()
      if (snapshot.lifecycle !== 'initializing') throw new Error('wiki-migration-lifecycle-invalid')
      const changes = (report.changes ?? []).map(change => ({ objectKind: change.objectKind, relativePath: change.relativePath,
        expectedOldHash: change.oldHash, expectedOldExists: change.oldExists, newBytes: Buffer.from(change.newBytes) }))
      if (!changes.length) throw new Error('wiki-migration-plan-empty')
      const manifest = await journal.prepare(changes)
      await lifecycle.beginMigration(input.preflightHash, manifest.migrationId)
      const completed = await journal.apply(manifest.migrationId, {
        crashAfterWriteIndex: input.crashAfterWriteIndex,
        onVerifiedComplete: () => lifecycle.completeMigration(input.preflightHash, manifest.migrationId, { lockHeld: true })
      })
      if (completed.status === 'conflict') throw new Error('wiki-migration-conflict')
      return completed
    },

    async resume(input: { migrationId: string; preflightHash: string }): Promise<WikiMigrationManifest> {
      const snapshot = await lifecycle.read()
      if (snapshot.lifecycle !== 'initializing' || snapshot.preflightHash !== input.preflightHash || snapshot.migrationId !== input.migrationId) throw new Error('wiki-migration-lifecycle-invalid')
      const completed = await journal.apply(input.migrationId, {
        onVerifiedComplete: () => lifecycle.completeMigration(input.preflightHash, input.migrationId, { lockHeld: true })
      })
      return completed
    },

    rollback(input: { migrationId: string; preflightHash: string }): Promise<WikiMigrationManifest> {
      return journal.rollback(input.migrationId)
    },

    read(migrationId: string): Promise<WikiMigrationManifest> { return journal.read(migrationId) }
  }
}
