import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { assertArchiveLimits, assertNoLinks, safeJoin, validateArchiveEntries } from '../../scripts/prepare-ripgrep.mjs'

describe('ripgrep archive extraction security', () => {
  it('拒绝解压树中的符号链接', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-links-'))
    await fs.symlink('/tmp', path.join(root, 'escape'))
    await expect(assertNoLinks(root)).rejects.toThrow(/symbolic link/)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('拒绝解压树中的硬链接', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-hardlinks-'))
    await fs.writeFile(path.join(root, 'one'), 'same')
    await fs.link(path.join(root, 'one'), path.join(root, 'two'))
    await expect(assertNoLinks(root)).rejects.toThrow(/hard link/)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('拒绝解压后内容超过总大小上限', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-size-'))
    await fs.writeFile(path.join(root, 'large'), Buffer.alloc(50 * 1024 * 1024 + 1))
    await expect(assertArchiveLimits(root)).rejects.toThrow(/size limit/)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('拒绝归档绝对路径和路径穿越', () => {
    expect(() => safeJoin('/tmp/extract', '../escape')).toThrow(/unsafe archive path/)
    expect(() => safeJoin('/tmp/extract', '/etc/passwd')).toThrow(/unsafe archive path/)
    expect(safeJoin('/tmp/extract', 'dir/rg')).toBe('/tmp/extract/dir/rg')
  })

  it('拒绝归档重复条目和过多条目', () => {
    expect(() => validateArchiveEntries(['root/rg', 'root/rg'])).toThrow(/duplicate/)
    expect(() => validateArchiveEntries(Array.from({ length: 4097 }, (_, i) => `root/${i}`))).toThrow(/too many/)
  })
})
