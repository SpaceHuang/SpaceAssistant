import fs from 'fs/promises'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { probeWritePathFact } from './writePathFacts'

describe('probeWritePathFact', () => {
  it('为普通存在与缺失目标产出规范化路径、zone 和父目录 identity', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-out-'))
    try {
      const existing = path.join(root, 'existing.txt')
      await fs.writeFile(existing, 'old')
      const existingFact = await probeWritePathFact({ rawPath: existing, workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: path.join(root, '.home'), customSensitivePrefixes: [] })
      const missingFact = await probeWritePathFact({ rawPath: path.join(outside, 'new.txt'), workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: path.join(root, '.home'), customSensitivePrefixes: [] })

      expect(existingFact).toMatchObject({ rawPath: existing, normalizedPath: existing, zone: 'workdir-normal', targetKind: 'file', parentReal: root })
      expect(existingFact.identity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number), mode: expect.any(Number) })
      expect(existingFact.parentIdentity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number), mode: expect.any(Number) })
      expect(missingFact).toMatchObject({ normalizedPath: path.join(outside, 'new.txt'), zone: 'outside-workdir', targetKind: 'missing', parentReal: outside })
      expect(missingFact.identity).toBeUndefined()
      expect(missingFact.parentIdentity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('敏感和系统目录优先于工作目录分区', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-zones-'))
    try {
      const sensitiveDir = path.join(root, 'secrets')
      await fs.mkdir(sensitiveDir)
      const sensitive = await probeWritePathFact({ rawPath: path.join(sensitiveDir, 'token'), workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: path.join(root, '.home'), customSensitivePrefixes: [] })
      const system = await probeWritePathFact({ rawPath: '/etc/spaceassistant-write-test', workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: path.join(root, '.home'), customSensitivePrefixes: [] })

      expect(sensitive).toMatchObject({ zone: 'sensitive-file', targetKind: 'missing' })
      expect(system).toMatchObject({ zone: 'system-dir' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('将 symlink 目标作为事实交给后续机制拒绝，不在 facts 阶段做策略裁决', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-link-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-link-out-'))
    try {
      const target = path.join(outside, 'target.txt')
      const link = path.join(root, 'link.txt')
      await fs.writeFile(target, 'outside')
      await fs.symlink(target, link)
      const fact = await probeWritePathFact({ rawPath: link, workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: path.join(root, '.home'), customSensitivePrefixes: [] })
      expect(fact).toMatchObject({ normalizedPath: target, zone: 'outside-workdir', targetKind: 'symlink' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('把硬链接目标明确分类为 hardlink', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-hardlink-'))
    try {
      const original = path.join(root, 'original.txt')
      const linked = path.join(root, 'linked.txt')
      await fs.writeFile(original, 'same inode')
      await fs.link(original, linked)
      const fact = await probeWritePathFact({ rawPath: linked, workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: path.join(root, '.home'), customSensitivePrefixes: [] })
      expect(fact).toMatchObject({ targetKind: 'hardlink', identity: { nlink: 2 } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('缺失目标经过 symlink 父目录时仍分类为 symlink', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-parent-link-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-parent-link-out-'))
    try {
      await fs.symlink(outside, path.join(root, 'linked-dir'), 'dir')
      const fact = await probeWritePathFact({ rawPath: 'linked-dir/new.txt', workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: root, customSensitivePrefixes: [] })
      expect(fact).toMatchObject({ targetKind: 'symlink', zone: 'outside-workdir', normalizedPath: path.join(outside, 'new.txt') })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('工作目录外的中间 symlink 也必须作为写目标事实保留', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-out-link-root-'))
    const aliasRoot = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-out-link-alias-'))
    const actualRoot = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-out-link-target-'))
    try {
      const target = path.join(actualRoot, 'existing.txt')
      await fs.writeFile(target, 'existing')
      await fs.symlink(actualRoot, path.join(aliasRoot, 'alias'), 'dir')
      const fact = await probeWritePathFact({ rawPath: path.join(aliasRoot, 'alias', 'existing.txt'), workDir: root, userDataDir: path.join(root, '.userdata'), homeDir: root, customSensitivePrefixes: [] })
      expect(fact).toMatchObject({ normalizedPath: target, zone: 'outside-workdir', targetKind: 'symlink' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(aliasRoot, { recursive: true, force: true })
      await fs.rm(actualRoot, { recursive: true, force: true })
    }
  })
})
