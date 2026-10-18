import type { WikiBootstrapMigrationPreview } from '../../src/shared/domainTypes'

export interface WikiBootstrapMigrationApprovalService {
  preview: () => Promise<WikiBootstrapMigrationPreview>
  apply: (manifestHash: string) => Promise<{ status: 'completed' }>
}

/**
 * final-check: `wiki:domain-migration-apply` obtains a new preview, presents its manifest hash in
 * the native host dialog, and only then calls apply. The service re-preflights again before the
 * migration barrier. Boundary coverage: wikiBootstrapMigrationApproval.test.ts and
 * wikiBootstrapMigration.test.ts.
 */
export async function confirmAndApplyWikiBootstrapMigration(
  service: WikiBootstrapMigrationApprovalService,
  requestedManifestHash: string,
  confirmInHost: (preview: WikiBootstrapMigrationPreview) => Promise<boolean>
): Promise<{ status: 'completed' | 'cancelled' }> {
  const preview = await service.preview()
  if (!requestedManifestHash || preview.manifestHash !== requestedManifestHash) throw new Error('wiki-migration-preflight-stale')
  if (preview.diagnostics.length) throw new Error('wiki-migration-preflight-conflicts')
  if (!await confirmInHost(preview)) return { status: 'cancelled' }
  return service.apply(preview.manifestHash)
}
