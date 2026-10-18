import { describe, expect, it } from 'vitest'
import { reconcileWikiFiles, serializeWikiPageMarker } from './wikiReconciler'

describe('reconcileWikiFiles', () => {
  it('registers first-seen pages at revision 1 and hashes the exact bytes', () => {
    const markdown = `${serializeWikiPageMarker({ pageId: 'p-1', categoryId: 'topic', summary: 'Summary', parentPageId: null, sourceRefs: [], revision: 1 })}\n# Title\nBody\n`
    const result = reconcileWikiFiles([{ path: 'wiki/topic.md', content: markdown }], [])
    expect(result.pages).toMatchObject([{ pageId: 'p-1', path: 'wiki/topic.md', title: 'Title', revision: 1, externalEdit: false }])
    expect(result.diagnostics).toEqual([])
  })

  it('advances revision for changed files and reports duplicate identities as conflicts', () => {
    const marker = serializeWikiPageMarker({ pageId: 'p-1', categoryId: 'topic', summary: '', parentPageId: null, sourceRefs: [], revision: 4 })
    const result = reconcileWikiFiles([
      { path: 'wiki/a.md', content: `${marker}\n# A` },
      { path: 'wiki/b.md', content: `${marker}\n# B` },
    ], [{ pageId: 'p-1', path: 'wiki/old.md', revision: 4, contentHash: 'old-hash' }])
    expect(result.pages).toEqual([])
    expect(result.diagnostics.map(item => item.code)).toContain('wiki-page-identity-duplicate')
  })

  it('preserves revision identity across an external move and reports disappeared pages as tombstones', () => {
    const moved = serializeWikiPageMarker({ pageId: 'p-moved', categoryId: 'topic', summary: '', parentPageId: null, sourceRefs: [], revision: 1 })
    const result = reconcileWikiFiles([{ path: 'wiki/new-location.md', content: `${moved}\n# Moved\nupdated body` }], [
      { pageId: 'p-moved', path: 'wiki/old-location.md', revision: 2, contentHash: 'old-content' },
      { pageId: 'p-deleted', path: 'wiki/deleted.md', revision: 7, contentHash: 'deleted-content' },
    ])
    expect(result.pages).toMatchObject([{ pageId: 'p-moved', path: 'wiki/new-location.md', revision: 3, externalEdit: true }])
    expect(result.tombstones).toEqual([{ pageId: 'p-deleted', path: 'wiki/deleted.md', revision: 7, deleted: true }])
  })

  it('does not guess identity when the marker is missing or malformed', () => {
    const result = reconcileWikiFiles([
      { path: 'wiki/no-marker.md', content: '# Untagged' },
      { path: 'wiki/bad-marker.md', content: '<!-- wiki-page:start -->\nno json\n<!-- wiki-page:end -->\n# Bad' },
    ], [])
    expect(result.pages).toEqual([])
    expect(result.diagnostics.map(item => item.code)).toEqual(['wiki-page-marker-invalid', 'wiki-page-marker-missing'])
  })

  it('does not accept a reconciliation that breaks schema category references', () => {
    const marker = serializeWikiPageMarker({ pageId: 'p-invalid', categoryId: 'missing-category', summary: '', parentPageId: null, sourceRefs: [], revision: 1 })
    const result = reconcileWikiFiles([{ path: 'wiki/a.md', content: `${marker}\n# A` }], [], { categories: [{ id: 'topic', status: 'active' }] })
    expect(result.diagnostics.map(item => item.code)).toContain('wiki-page-category-invalid')
  })
})
