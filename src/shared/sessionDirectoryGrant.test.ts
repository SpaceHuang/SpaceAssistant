import { describe, expect, it } from 'vitest'
import { buildSessionDirectoryContextBlock, isPathWithinGrantedDirectory, normalizeDirectoryGrantPath } from './sessionDirectoryGrant'

describe('session directory grant path scope', () => {
  it('builds a scoped agent context section and leaves empty sessions unchanged', () => {
    const record = { grantId: 'g', sessionId: 's', path: '/tmp/docs', realPath: '/tmp/docs', identity: { dev: 1, ino: 2, mode: 3 }, createdAt: 1, source: 'user-selected-directory' as const }
    expect(buildSessionDirectoryContextBlock([], 'zh-CN')).toBe('')
    expect(buildSessionDirectoryContextBlock([record], 'zh-CN')).toContain('不表示要求立即扫描全部内容')
    expect(buildSessionDirectoryContextBlock([record], 'en-US')).toContain('does not approve writes')
    expect(buildSessionDirectoryContextBlock([record], 'en-US')).toContain('/tmp/docs')
  })
  it('normalizes POSIX and Windows paths for boundary comparisons', () => {
    expect(normalizeDirectoryGrantPath('/tmp/data/../safe/')).toBe('/tmp/safe')
    expect(normalizeDirectoryGrantPath('C:\\Work\\Docs\\')).toBe('c:/work/docs')
  })

  it('rejects UNC roots that differ at the server or share boundary', () => {
    expect(isPathWithinGrantedDirectory('\\\\server\\share\\docs\\a.txt', '\\\\server\\share\\docs')).toBe(true)
    expect(isPathWithinGrantedDirectory('\\\\server\\share-secret\\docs\\a.txt', '\\\\server\\share\\docs')).toBe(false)
    expect(isPathWithinGrantedDirectory('\\\\other\\share\\docs\\a.txt', '\\\\server\\share\\docs')).toBe(false)
  })

  it.each([
    ['/selected', '/selected', true],
    ['/selected/child/file.txt', '/selected', true],
    ['/selected-prefix-other/file.txt', '/selected', false],
    ['/parent/selected/file.txt', '/parent/selected', true],
    ['/parent/selected-sibling/file.txt', '/parent/selected', false],
    ['C:\\Work\\Docs\\a.txt', 'c:/work/docs', true],
    ['C:\\Work\\DocsBackup\\a.txt', 'C:\\Work\\Docs', false],
    ['/selected/../outside/file', '/selected', false]
  ])('classifies %s relative to grant root %s as %s', (target, root, expected) => {
    expect(isPathWithinGrantedDirectory(target, root)).toBe(expected)
  })
})
