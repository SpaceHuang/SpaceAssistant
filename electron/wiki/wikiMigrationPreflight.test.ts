import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildWikiMigrationPreflight, createWikiMigrationPreflight } from './wikiMigrationPreflight'
import { scanWikiMigrationPreflight } from './wikiMigrationPreflight'
import { createWikiFileStore } from './wikiFileStore'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

describe('createWikiMigrationPreflight', () => {
  it('scans a Wiki root read-only and reports symlinks without following them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-preflight-scan-'))
    try {
      await mkdir(path.join(root, 'wiki', 'entities'), { recursive: true })
      await writeFile(path.join(root, 'SCHEMA.md'), '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"entity","name":"Entity","description":"Entities","status":"active"}]}\n<!-- wiki-categories:end -->\n')
      await writeFile(path.join(root, 'wiki', 'entities', 'a.md'), '# A\n')
      await symlink(path.join(root, 'wiki', 'entities', 'a.md'), path.join(root, 'wiki', 'entities', 'linked.md'))
      const report = await scanWikiMigrationPreflight(createWikiFileStore(root))
      expect(report.files.map(file => file.path)).toContain('wiki/entities/a.md')
      expect(report.files.map(file => file.path)).not.toContain('wiki/entities/linked.md')
      expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'wiki-migration-symlink-rejected', paths: ['wiki/entities/linked.md'] }))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('maps legacy category tables to stable schema IDs and prepares marker writes without touching inputs', () => {
    const schema = `# Wiki rules\n\n## 页面类型\n\n| 类型 | 目录 | 说明 |\n|------|------|------|\n| entity | wiki/entities/ | People and organizations |\n| concept | wiki/concepts/ | Terms |\n`
    const files = [{ path: 'wiki/entities/space.md', content: '# Space\nBody\n' }, { path: 'wiki/index.md', content: '# Wiki Index\n' }, { path: 'wiki/log.md', content: '## old event\n' }]
    const before = JSON.stringify({ schema, files })
    const report = buildWikiMigrationPreflight({ schema, files })
    expect(report.categories.map(item => item.categoryId)).toEqual(['entity', 'concept'])
    expect(report.changes).toHaveLength(3)
    expect(report.changes?.find(change => change.relativePath === 'wiki/entities/space.md')).toMatchObject({ objectKind: 'page', oldHash: createHash('sha256').update(files[0].content).digest('hex') })
    expect(report.changes?.find(change => change.relativePath === 'wiki/entities/space.md')?.newBytes).toContain('"categoryId":"entity"')
    expect(report.changes?.find(change => change.relativePath === 'SCHEMA.md')?.newBytes).toContain('"id": "entity"')
    expect(report.files.find(file => file.path === 'wiki/log.md')?.kind).toBe('legacy-log')
    expect(report.review.readonlyLogArchives).toHaveLength(1)
    expect(report.review.indexNotes).toEqual([])
    expect(JSON.stringify({ schema, files })).toBe(before)
  })

  it('extracts human index notes, flags unclassified blocks, and records a read-only log archive', () => {
    const report = buildWikiMigrationPreflight({
      schema: '# Rules\n\n## 页面类型\n\n| 类型 | 目录 | 说明 |\n|------|------|------|\n| entity | wiki/entities/ | Entities |\n',
      files: [
        { path: 'wiki/index.md', content: '# Wiki Index\n\n> Generated navigation.\n\n## Entities\n\n（暂无）\n\n## Notes\n\nKeep the old design rationale.\n' },
        { path: 'wiki/log.md', content: '## [old] ingest\nKeep as archive.\n' },
        { path: 'wiki/entities/a.md', content: '# A\n' },
      ]
    })
    expect(report.review.indexNotes).toMatchObject([{ targetTitle: 'Wiki 旧索引说明（Notes）', content: 'Keep the old design rationale.' }])
    expect(report.review.readonlyLogArchives[0]).toMatchObject({ sourcePath: 'wiki/log.md', sha256: createHash('sha256').update('## [old] ingest\nKeep as archive.\n').digest('hex') })
    expect(report.changes?.map(change => change.objectKind)).toContain('index-note')
    expect(report.diagnostics.map(item => item.code)).not.toContain('wiki-migration-index-content-unclassified')
  })

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
