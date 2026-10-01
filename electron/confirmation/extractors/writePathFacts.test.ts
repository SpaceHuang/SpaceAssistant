import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { classifyWriteTargetScope, probeWritePathFact } from './writePathFacts'
import { canCreateSymlinks } from '../../../src/test/symlinkCapability'

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

  it('拒绝父目录不存在的深层新文件，避免 permit 只绑定到更高层祖先', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-missing-parent-'))
    try {
      await expect(probeWritePathFact({
        rawPath: path.join(root, 'new', 'nested', 'file.txt'),
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        homeDir: root,
        customSensitivePrefixes: []
      })).rejects.toMatchObject({ caseId: 'write-parent-directory-missing' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
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

  // 依赖真实 symlink/hardlink 的用例以能力探测保护：win32 非特权进程无 SeCreateSymbolicLinkPrivilege；
  // symlink 安全语义由 toolCallGate 的 mock 通路用例在 win32 覆盖，Linux CI/特权环境照常真跑。
  it.skipIf(!canCreateSymlinks())('将 symlink 目标作为事实交给后续机制拒绝，不在 facts 阶段做策略裁决', async () => {
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

  it.skipIf(!canCreateSymlinks())('把硬链接目标明确分类为 hardlink', async () => {
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

  it.skipIf(!canCreateSymlinks())('缺失目标经过 symlink 父目录时仍分类为 symlink', async () => {
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

  it.skipIf(!canCreateSymlinks())('工作目录外的中间 symlink 也必须作为写目标事实保留', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-out-link-root-'))
    const aliasRoot = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-out-link-alias-'))
    const actualRoot = await fs.realpath(await fs.mkdtemp('/tmp/write-fact-out-link-target-'))
    try {
      const target = path.join(actualRoot, 'existing.txt')
      await fs.writeFile(target, 'existing')
      await fs.symlink(actualRoot, path.join(aliasRoot, 'alias'), 'dir')
      const fact = await probeWritePathFact({ rawPath: path.join(aliasRoot, 'alias', 'existing.txt'), workDir: root, userDataDir: root, homeDir: root, customSensitivePrefixes: [] })
      expect(fact).toMatchObject({ normalizedPath: target, zone: 'outside-workdir', targetKind: 'symlink' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(aliasRoot, { recursive: true, force: true })
      await fs.rm(actualRoot, { recursive: true, force: true })
    }
  })
})

/**
 * merge-main-28 修复回归锚（docs/review/2026-09-29-merge-main-28-failures-analysis-and-fix-plan.md §5 批次 1.5）。
 */
describe('跨平台路径语法分派回归锚', () => {
  it('锚①(write)：相对路径按 workDir 真实基座 resolve，产 workdir-normal（B1 回归）', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'write-fact-anchor1-')))
    try {
      await fs.mkdir(path.join(root, 'src'))
      await expect(probeWritePathFact({
        rawPath: 'src/x.ts',
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        homeDir: path.join(root, '.home'),
        customSensitivePrefixes: []
      })).resolves.toMatchObject({
        normalizedPath: path.resolve(root, 'src/x.ts'),
        zone: 'workdir-normal',
        targetKind: 'missing'
      })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('锚⑥：POSIX workDir 字面量 + POSIX 绝对目标 → 正常返回不抛错、system-dir（1.3 env 豁免 + 1.4a 根守卫静默退出）', async () => {
    // 目标随平台存在性不同（Linux 上 /etc/hosts 真实存在、win32 上缺失），只断言形态与 zone；
    // env canonicalize 取真实 realpath 答案（truthful，形态不限），zone 判定与之解耦，不依赖测试机 E:\tmp 是否存在。
    await expect(probeWritePathFact({
      rawPath: '/etc/hosts',
      workDir: '/tmp/wd',
      userDataDir: '/tmp/user-data',
      homeDir: '/tmp/home',
      customSensitivePrefixes: []
    })).resolves.toMatchObject({ normalizedPath: await fs.realpath('/etc/hosts').catch(() => '/etc/hosts'), zone: 'system-dir' })
  })
})

/**
 * CI 修复回归锚（GitHub Linux runner 红：remote-write-scope-unknown-deny 误伤）：
 * classifyWriteTargetScope 的 POSIX 分支曾对 workDir 发 fs.realpath——workDir 尚未创建
 * （新会话首写是常态）时 ENOENT → scope=unknown → 远程写入被 scope-unknown-deny 终局拒绝。
 */
describe('classifyWriteTargetScope 存在性依赖回归锚', () => {
  it('workDir 尚未创建（不可达）时按 lexical 判归属，产出 inside 而非 unknown/outside', async () => {
    const missingWorkDir = `/tmp/spaceassistant-missing-wd-${Date.now()}`
    await expect(fs.realpath(missingWorkDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(classifyWriteTargetScope(`${missingWorkDir}/a.txt`, missingWorkDir)).resolves.toBe('inside-workdir')
  })

  it('workDir 真实存在时行为不变：子路径 inside、同层外部路径 outside', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'write-scope-real-')))
    try {
      await expect(classifyWriteTargetScope(path.join(root, 'a.txt'), root)).resolves.toBe('inside-workdir')
      await expect(classifyWriteTargetScope(path.join(path.dirname(root), 'outside.txt'), root)).resolves.toBe('outside-workdir')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
