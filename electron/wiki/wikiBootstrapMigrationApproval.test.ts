import { describe, expect, it, vi } from 'vitest'
import { confirmAndApplyWikiBootstrapMigration } from './wikiBootstrapMigrationApproval'
import type { WikiBootstrapMigrationPreview } from '../../src/shared/domainTypes'

const preview: WikiBootstrapMigrationPreview = {
  manifestHash: 'manifest-1', resumeRequired: false, files: [], diagnostics: [], changes: [],
  review: { categories: [], indexNotes: [], unclassifiedIndexContent: [], readonlyLogArchives: [] }
}

describe('host-bound Wiki migration approval', () => {
  it('does not show host confirmation when the reviewed report is stale', async () => {
    const service = { preview: vi.fn().mockResolvedValue(preview), apply: vi.fn() }
    const confirmInHost = vi.fn().mockResolvedValue(true)
    await expect(confirmAndApplyWikiBootstrapMigration(service, 'other-manifest', confirmInHost)).rejects.toThrow('wiki-migration-preflight-stale')
    expect(confirmInHost).not.toHaveBeenCalled()
    expect(service.apply).not.toHaveBeenCalled()
  })

  it('leaves the root unchanged when the native host prompt is declined', async () => {
    const service = { preview: vi.fn().mockResolvedValue(preview), apply: vi.fn() }
    const result = await confirmAndApplyWikiBootstrapMigration(service, preview.manifestHash, vi.fn().mockResolvedValue(false))
    expect(result).toEqual({ status: 'cancelled' })
    expect(service.apply).not.toHaveBeenCalled()
  })

  it('does not offer a confirmation button for a preflight with conflicts', async () => {
    const conflicted = { ...preview, diagnostics: [{ code: 'conflict', paths: ['SCHEMA.md'], message: 'Invalid schema' }] }
    const service = { preview: vi.fn().mockResolvedValue(conflicted), apply: vi.fn() }
    const confirmInHost = vi.fn().mockResolvedValue(true)
    await expect(confirmAndApplyWikiBootstrapMigration(service, preview.manifestHash, confirmInHost)).rejects.toThrow('wiki-migration-preflight-conflicts')
    expect(confirmInHost).not.toHaveBeenCalled()
    expect(service.apply).not.toHaveBeenCalled()
  })

  it('applies only the exact manifest the host dialog confirmed', async () => {
    const service = { preview: vi.fn().mockResolvedValue(preview), apply: vi.fn().mockResolvedValue({ status: 'completed' as const }) }
    const confirmInHost = vi.fn().mockResolvedValue(true)
    await expect(confirmAndApplyWikiBootstrapMigration(service, preview.manifestHash, confirmInHost)).resolves.toEqual({ status: 'completed' })
    expect(confirmInHost).toHaveBeenCalledWith(preview)
    expect(service.apply).toHaveBeenCalledWith(preview.manifestHash)
  })
})
