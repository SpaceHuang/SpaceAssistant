import { describe, expect, it } from 'vitest'
import {
  projectDisplayMap,
  resolveMigratedLink,
  summarizeMigrationReport
} from './wikiMigrationUi'

describe('resolveMigratedLink（T2.5④ 改名映射）', () => {
  const renames = [
    { from: 'llm-wiki/wiki/entities/conflict.md', to: 'llm-wiki/wiki/entities/conflict.from-p-12345678.md' }
  ]

  it('命中映射 → 返回新词汇路径', () => {
    expect(resolveMigratedLink(renames, 'llm-wiki/wiki/entities/conflict.md')).toBe(
      'llm-wiki/wiki/entities/conflict.from-p-12345678.md'
    )
  })

  it('未命中 → null（展示通用读取失败提示）', () => {
    expect(resolveMigratedLink(renames, 'llm-wiki/wiki/entities/other.md')).toBeNull()
    expect(resolveMigratedLink(undefined, 'llm-wiki/wiki/entities/conflict.md')).toBeNull()
    expect(resolveMigratedLink([], 'llm-wiki/wiki/entities/conflict.md')).toBeNull()
  })
})

describe('projectDisplayMap（T2.5⑤ raw 节点显示名数据源）', () => {
  it('映射 projectId → displayName/workDir/orphan', () => {
    const map = projectDisplayMap([
      { projectId: 'p-12345678', displayName: '项目A', workDir: 'E:\\a', orphan: false },
      { projectId: 'p-9abcdef0', displayName: 'archived', workDir: 'D:\\gone', orphan: true }
    ])
    expect(map.get('p-12345678')).toEqual({ displayName: '项目A', workDir: 'E:\\a', orphan: false })
    expect(map.get('p-9abcdef0')?.orphan).toBe(true)
    expect(projectDisplayMap(undefined).size).toBe(0)
  })
})

describe('summarizeMigrationReport（向导完成态）', () => {
  it('统计 migrated/conflicts/renames', () => {
    expect(summarizeMigrationReport({
      startedAt: 't',
      profiles: [{ workDir: 'a', rootDirName: 'llm-wiki', status: 'migrated' }, { workDir: 'b', rootDirName: 'llm-wiki', status: 'skipped' }],
      conflicts: [{ path: 'x', keptAs: 'y' }],
      renames: [{ from: 'x', to: 'y' }]
    })).toEqual({ migrated: 1, conflicts: 1, renames: 1 })
    expect(summarizeMigrationReport(undefined)).toEqual({ migrated: 0, conflicts: 0, renames: 0 })
  })
})
