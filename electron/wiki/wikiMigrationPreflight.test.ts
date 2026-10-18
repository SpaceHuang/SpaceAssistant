import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createWikiMigrationPreflight } from './wikiMigrationPreflight'

describe('createWikiMigrationPreflight', () => {
  it('creates deterministic category IDs and a content manifest without changing input files', () => {
    const input = {
      categories: [{ name: '自定义类别', description: '知识' }, { name: 'topic', id: 'topic' }],
      files: [{ path: 'wiki/a.md', content: '# A' }, { path: 'log.md', content: 'history' }],
      knownCategoryIds: ['topic'],
    }
    const before = JSON.stringify(input)
    const run = createWikiMigrationPreflight(input)
    expect(run).toEqual(createWikiMigrationPreflight(input))
    expect(JSON.stringify(input)).toBe(before)
    expect(run.categories).toMatchObject([{ legacyName: 'topic', categoryId: 'topic' }, { legacyName: '自定义类别' }])
    expect(run.files).toEqual([
      { path: 'log.md', sha256: createHash('sha256').update('history').digest('hex'), kind: 'legacy-log' },
      { path: 'wiki/a.md', sha256: createHash('sha256').update('# A').digest('hex'), kind: 'page' },
    ])
  })

  it('reports normalized title collisions and unclassified pages', () => {
    const run = createWikiMigrationPreflight({
      categories: [{ id: 'topic', name: 'topic' }],
      files: [{ path: 'wiki/a.md', content: '# Alpha' }, { path: 'wiki/b.md', content: '# alpha' }, { path: 'loose.txt', content: 'data' }],
      knownCategoryIds: ['topic'],
    })
    expect(run.diagnostics.map(item => item.code)).toContain('wiki-migration-title-conflict')
    expect(run.diagnostics.map(item => item.code)).toContain('wiki-migration-unclassified-file')
  })
})
