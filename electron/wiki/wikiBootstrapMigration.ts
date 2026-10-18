import { createHash } from 'node:crypto'
import type { WikiBootstrapMigrationPreview } from '../../src/shared/domainTypes'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiMigrationCoordinator } from './wikiMigrationCoordinator'
import type { WikiMigrationPreflightReport } from './wikiMigrationPreflight'

export type { WikiBootstrapMigrationPreview } from '../../src/shared/domainTypes'

export class WikiBootstrapMigrationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WikiBootstrapMigrationError' }
}

export function createWikiBootstrapMigrationService(wikiRoot: string) {
  const lifecycle = createWikiLifecycleController(wikiRoot)
  const coordinator = createWikiMigrationCoordinator(wikiRoot)

  return {
    async preview(): Promise<WikiBootstrapMigrationPreview> {
      // facts: the migration preflight reports files/changes/diagnostics; this method does not authorize writes.
      const state = await lifecycle.read()
      if (state.lifecycle !== 'initializing') throw new WikiBootstrapMigrationError('wiki-migration-lifecycle-invalid')
      if (state.migrationId) {
        const manifest = await coordinator.read(state.migrationId)
        if (manifest.status === 'conflict' || manifest.status === 'rolled_back' || manifest.status === 'rolling_back') throw new WikiBootstrapMigrationError('wiki-migration-recovery-required')
        return {
          manifestHash: state.preflightHash!,
          resumeRequired: true,
          files: [],
          diagnostics: [],
          changes: manifest.entries.map(entry => ({ objectKind: entry.objectKind, relativePath: entry.relativePath, oldHash: entry.oldHash ?? '', newHash: entry.newHash })),
          review: { categories: [], indexNotes: [], unclassifiedIndexContent: [], readonlyLogArchives: [] }
        }
      }
      return projectPreview(await coordinator.preflight(), false)
    },

    async apply(confirmedPreflightHash: string): Promise<{ status: 'completed' }> {
      const state = await lifecycle.read()
      if (state.lifecycle !== 'initializing') throw new WikiBootstrapMigrationError('wiki-migration-lifecycle-invalid')
      if (state.migrationId) {
        if (!confirmedPreflightHash || confirmedPreflightHash !== state.preflightHash) throw new WikiBootstrapMigrationError('wiki-migration-confirmation-mismatch')
        const result = await coordinator.resume({ migrationId: state.migrationId, preflightHash: state.preflightHash! })
        if (result.status !== 'completed') throw new WikiBootstrapMigrationError('wiki-migration-conflict')
        return { status: 'completed' }
      }
      // final-check: recompute only the exact mutation material and compare it to the host-approved manifest hash.
      const fresh = await coordinator.preflight()
      if (!confirmedPreflightHash || fresh.manifestHash !== confirmedPreflightHash) throw new WikiBootstrapMigrationError('wiki-migration-preflight-stale')
      if (fresh.diagnostics.length) throw new WikiBootstrapMigrationError('wiki-migration-preflight-conflicts')
      if (!fresh.changes?.length) {
        await lifecycle.completeInitialization(fresh.manifestHash)
        return { status: 'completed' }
      }
      const result = await coordinator.migrate({ preflightHash: fresh.manifestHash, confirmedPreflightHash })
      if (result.status !== 'completed') throw new WikiBootstrapMigrationError('wiki-migration-conflict')
      return { status: 'completed' }
    }
  }
}

function projectPreview(report: WikiMigrationPreflightReport, resumeRequired: boolean): WikiBootstrapMigrationPreview {
  return {
    manifestHash: report.manifestHash,
    resumeRequired,
    files: report.files,
    diagnostics: report.diagnostics,
    changes: (report.changes ?? []).map(change => ({
      objectKind: change.objectKind,
      relativePath: change.relativePath,
      oldHash: change.oldHash,
      newHash: createHash('sha256').update(change.newBytes).digest('hex')
    })),
    review: {
      categories: report.categories,
      indexNotes: report.review.indexNotes.map(({ sourcePath, targetTitle }) => ({ sourcePath, targetTitle })),
      unclassifiedIndexContent: report.review.unclassifiedIndexContent.map(({ sourcePath }) => ({ sourcePath })),
      readonlyLogArchives: report.review.readonlyLogArchives
    }
  }
}
