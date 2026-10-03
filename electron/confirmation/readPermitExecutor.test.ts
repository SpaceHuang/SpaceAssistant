import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { buildReadExecutionPermit, type ReadPermitIdentity } from './readExecutionPermit'
import { resolveReadPermitTarget } from './readPermitExecutor'
import { canCreateSymlinks } from '../../src/test/symlinkCapability'

const dirIdentity = (stat: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }): ReadPermitIdentity =>
  ({ dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs })

describe('resolveReadPermitTarget', () => {
  it('目录 permit 仅返回身份匹配的 direct-entries 目标（带 targetKind 判别字段）', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-directory-permit-')))
    try {
      const input = { path: dir }
      const stat = await fs.stat(dir)
      const permit = buildReadExecutionPermit({
        requestId: 'r-dir', toolUseId: 't-dir', toolName: 'list_directory', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries', identity: dirIdentity(stat) }]
      })
      await expect(resolveReadPermitTarget('list_directory', input, { requestId: 'r-dir', toolUseId: 't-dir', readExecutionPermit: permit } as never)).resolves.toEqual({ ok: true, path: dir, targetKind: 'directory' })
      // AC-21d：badPermit 改用 mode 构造（size 不再参与目录 identity 比对，size 偏移将假绿；
      // 计划建议的 ino+1 在 Windows NTFS 大 ino（>2^53）下被浮点精度吞掉——mode 为小整数，跨平台安全）
      const badPermit = buildReadExecutionPermit({
        requestId: 'r-dir', toolUseId: 't-dir', toolName: 'list_directory', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries', identity: dirIdentity({ ...stat, mode: stat.mode + 1 }) }]
      })
      await expect(resolveReadPermitTarget('list_directory', input, { requestId: 'r-dir', toolUseId: 't-dir', readExecutionPermit: badPermit } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-identity-changed', failureClass: 'mechanism' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('list_directory 目录条目增删后 identity 校验仍通过（identity 只绑 dev/ino/mode，AC-21c）', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-dir-entries-')))
    try {
      const input = { path: dir }
      const stat = await fs.stat(dir)
      const permit = buildReadExecutionPermit({
        requestId: 'r-entries', toolUseId: 't-entries', toolName: 'list_directory', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries', identity: dirIdentity(stat) }]
      })
      // 确认窗口内目录条目变动：新增 + 删除
      await fs.writeFile(path.join(dir, 'new-entry.txt'), 'x')
      await expect(resolveReadPermitTarget('list_directory', input, { requestId: 'r-entries', toolUseId: 't-entries', readExecutionPermit: permit } as never)).resolves.toMatchObject({ ok: true, targetKind: 'directory' })
      await fs.unlink(path.join(dir, 'new-entry.txt'))
      await expect(resolveReadPermitTarget('list_directory', input, { requestId: 'r-entries', toolUseId: 't-entries', readExecutionPermit: permit } as never)).resolves.toMatchObject({ ok: true, targetKind: 'directory' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('list_directory 根 realpath 与冻结值不符时报 read-directory-realpath-changed（C8/AC-50）', async () => {
    if (!(await canCreateSymlinks())) return
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-dir-realpath-')))
    try {
      const real = path.join(parent, 'real')
      await fs.mkdir(real)
      const link = path.join(parent, 'link')
      await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
      const input = { path: link }
      const stat = await fs.stat(link)
      // 非法形态：normalizedPath 含链接成分（非 realpath 结果）——executor 须以 realpath-changed 拒绝
      const permit = buildReadExecutionPermit({
        requestId: 'r-realpath', toolUseId: 't-realpath', toolName: 'list_directory', input,
        facts: [{ factId: `fact-${link}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: link, zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries', identity: dirIdentity(stat) }]
      })
      await expect(resolveReadPermitTarget('list_directory', input, { requestId: 'r-realpath', toolUseId: 't-realpath', readExecutionPermit: permit } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-realpath-changed', failureClass: 'mechanism' })
    } finally { await fs.rm(parent, { recursive: true, force: true }) }
  })

  it('grep 目录 permit：scope=subtree 且 identity 匹配时放行（AC-05 前置）', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-subtree-permit-')))
    try {
      const input = { path: dir, pattern: 'x' }
      const stat = await fs.stat(dir)
      const permit = buildReadExecutionPermit({
        requestId: 'r-sub', toolUseId: 't-sub', toolName: 'grep', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'subtree', identity: dirIdentity(stat) }]
      })
      await expect(resolveReadPermitTarget('grep', input, { requestId: 'r-sub', toolUseId: 't-sub', readExecutionPermit: permit } as never)).resolves.toEqual({ ok: true, path: dir, targetKind: 'directory' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('selected-directory permit rechecks the session, root identity and target containment in the executor', async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-selected-grant-')))
    const root = path.join(parent, 'selected')
    const outside = path.join(parent, 'outside.txt')
    await fs.mkdir(root)
    const target = path.join(root, 'note.txt')
    await fs.writeFile(target, 'ok'); await fs.writeFile(outside, 'no')
    try {
      const realRoot = await fs.realpath(root)
      const rootStat = await fs.stat(realRoot)
      const targetStat = await fs.stat(target)
      const input = { path: target }
      const makePermit = (normalizedPath: string, identity: ReadPermitIdentity) => buildReadExecutionPermit({
        requestId: 'grant-req', toolUseId: 'grant-use', toolName: 'read_file', input,
        facts: [{ factId: 'grant-fact', decisionRuleId: 'path-outside-readonly-allow', normalizedPath, zone: 'outside-workdir', targetKind: 'file', identity, directoryGrant: { grantId: 'g1', sessionId: 's1', realPath: realRoot, identity: { dev: rootStat.dev, ino: rootStat.ino, mode: rootStat.mode } } }]
      })
      const valid = makePermit(await fs.realpath(target), dirIdentity(targetStat))
      const context = { requestId: 'grant-req', toolUseId: 'grant-use', sessionId: 's1', lane: 'desktop', readExecutionPermit: valid, isSessionDirectoryGrantActive: () => true }
      const result = await resolveReadPermitTarget('read_file', input, context as never)
      expect(result).toMatchObject({ ok: true, path: await fs.realpath(target) })
      if (result.ok && 'fileHandle' in result) await result.fileHandle.close()
      await expect(resolveReadPermitTarget('read_file', input, {
        ...context,
        isSessionDirectoryGrantActive: () => false
      } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-grant-revoked' })
      await expect(resolveReadPermitTarget('read_file', input, { ...context, sessionId: 's2' } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-grant-binding-mismatch' })
      const outOfScope = makePermit(outside, dirIdentity(await fs.stat(outside)))
      await expect(resolveReadPermitTarget('read_file', input, { ...context, readExecutionPermit: outOfScope } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-grant-scope-mismatch' })
      const moved = `${root}-moved`
      await fs.rename(root, moved); await fs.mkdir(root)
      await expect(resolveReadPermitTarget('read_file', input, { ...context, readExecutionPermit: valid } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-grant-identity-changed' })
    } finally { await fs.rm(parent, { recursive: true, force: true }) }
  })

  it('grep 目录 permit：identity（dev/ino/mode）变化 → read-directory-identity-changed（AC-05/AC-21）', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-subtree-identity-')))
    try {
      const input = { path: dir, pattern: 'x' }
      const stat = await fs.stat(dir)
      const permit = buildReadExecutionPermit({
        requestId: 'r-sub', toolUseId: 't-sub', toolName: 'grep', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'subtree', identity: dirIdentity({ ...stat, mode: stat.mode + 1 }) }]
      })
      await expect(resolveReadPermitTarget('grep', input, { requestId: 'r-sub', toolUseId: 't-sub', readExecutionPermit: permit } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-identity-changed', failureClass: 'mechanism' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('grep 目录 permit：确认窗口内条目增删后执行仍成功（AC-21b，不绑 size/mtimeMs）', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-subtree-entries-')))
    try {
      const input = { path: dir, pattern: 'x' }
      const stat = await fs.stat(dir)
      const permit = buildReadExecutionPermit({
        requestId: 'r-sub', toolUseId: 't-sub', toolName: 'grep', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'subtree', identity: dirIdentity(stat) }]
      })
      await fs.writeFile(path.join(dir, 'late-entry.txt'), 'needle')
      await expect(resolveReadPermitTarget('grep', input, { requestId: 'r-sub', toolUseId: 't-sub', readExecutionPermit: permit } as never)).resolves.toMatchObject({ ok: true, targetKind: 'directory' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('grep 目录 permit：根 realpath 与冻结值不符 → read-directory-realpath-changed（AC-06/AC-22）', async () => {
    if (!(await canCreateSymlinks())) return
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-subtree-realpath-')))
    try {
      const real = path.join(parent, 'real')
      await fs.mkdir(real)
      const link = path.join(parent, 'link')
      await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
      const input = { path: link, pattern: 'x' }
      const stat = await fs.stat(link)
      const permit = buildReadExecutionPermit({
        requestId: 'r-sub', toolUseId: 't-sub', toolName: 'grep', input,
        facts: [{ factId: `fact-${link}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: link, zone: 'workdir-normal', targetKind: 'directory', scope: 'subtree', identity: dirIdentity(stat) }]
      })
      await expect(resolveReadPermitTarget('grep', input, { requestId: 'r-sub', toolUseId: 't-sub', readExecutionPermit: permit } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-realpath-changed', failureClass: 'mechanism' })
    } finally { await fs.rm(parent, { recursive: true, force: true }) }
  })

  it.each([undefined, 'direct-entries' as const])('grep 目录 permit：scope 非 subtree（%s）→ permit-target-scope-mismatch（AC-07/AC-23）', async (scope) => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-subtree-scope-')))
    try {
      const input = { path: dir, pattern: 'x' }
      const stat = await fs.stat(dir)
      const permit = buildReadExecutionPermit({
        requestId: 'r-sub', toolUseId: 't-sub', toolName: 'grep', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', ...(scope ? { scope } : {}), identity: dirIdentity(stat) }]
      })
      await expect(resolveReadPermitTarget('grep', input, { requestId: 'r-sub', toolUseId: 't-sub', readExecutionPermit: permit } as never)).resolves.toMatchObject({ ok: false, caseId: 'permit-target-scope-mismatch', failureClass: 'mechanism' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('按绑定许可返回目标路径，并拒绝变更的请求或输入', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-permit-exec-')))
    try {
      const file = path.join(dir, 'a.txt'); await fs.writeFile(file, 'x'); const st = await fs.stat(file)
      const input = { path: file }
      const permit = buildReadExecutionPermit({ requestId: 'r', toolUseId: 't', toolName: 'read_file', input, facts: [{ factId: 'f', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: st.dev, ino: st.ino, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs } }] })
      const ctx = { requestId: 'r', toolUseId: 't', readExecutionPermit: permit } as never
      const resolved = await resolveReadPermitTarget('read_file', input, ctx)
      expect(resolved).toMatchObject({ ok: true, path: file })
      if (!resolved.ok) throw new Error('permit resolution failed')
      await fs.rename(file, `${file}.approved`)
      await fs.writeFile(file, 'attacker replacement')
      await expect(resolved.fileHandle.readFile({ encoding: 'utf8' })).resolves.toBe('x')
      await resolved.fileHandle.close()
      await expect(resolveReadPermitTarget('read_file', { path: '/wrong' }, ctx)).resolves.toEqual({ ok: false, caseId: 'input-digest-mismatch', failureClass: 'input', factId: 'f' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('拒绝审批后身份变化与缺少许可', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-permit-exec-')))
    try {
      const file = path.join(dir, 'a.txt'); await fs.writeFile(file, 'x'); const st = await fs.stat(file)
      const permit = buildReadExecutionPermit({ requestId: 'r', toolUseId: 't', toolName: 'read_file', input: { path: file }, facts: [{ factId: 'f', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: st.dev, ino: st.ino, mode: st.mode, size: 99, mtimeMs: st.mtimeMs } }] })
      await expect(resolveReadPermitTarget('read_file', { path: file }, { requestId: 'r', toolUseId: 't', readExecutionPermit: permit } as never)).resolves.toEqual({ ok: false, caseId: 'read-target-identity-changed', failureClass: 'mechanism', factId: 'f' })
      await expect(resolveReadPermitTarget('read_file', { path: file }, {} as never)).resolves.toEqual({ ok: false, caseId: 'read-permit-missing', failureClass: 'integration-violation' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('permit 目标在 gate 时已缺失时返回环境诊断并保留 factId', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-permit-missing-'))
    try {
      const file = path.join(dir, 'missing.txt')
      const input = { path: file }
      const permit = buildReadExecutionPermit({ requestId: 'r-missing', toolUseId: 't-missing', toolName: 'read_file', input, facts: [{ factId: 'missing-fact', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'missing' }] })
      await expect(resolveReadPermitTarget('read_file', input, { requestId: 'r-missing', toolUseId: 't-missing', readExecutionPermit: permit } as never))
        .resolves.toEqual({ ok: false, caseId: 'read-target-missing', failureClass: 'environment', factId: 'missing-fact' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('平台支持时以 O_NOFOLLOW 打开许可目标', async () => {
    if (!fsConstants.O_NOFOLLOW) return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-permit-nofollow-'))
    const open = fs.open.bind(fs)
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((...args) => open(...args))
    try {
      const file = path.join(dir, 'a.txt')
      await fs.writeFile(file, 'x')
      const st = await fs.stat(file)
      const input = { path: file }
      const permit = buildReadExecutionPermit({ requestId: 'r-nofollow', toolUseId: 't-nofollow', toolName: 'read_file', input, facts: [{ factId: 'f', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: st.dev, ino: st.ino, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs } }] })
      const result = await resolveReadPermitTarget('read_file', input, { requestId: 'r-nofollow', toolUseId: 't-nofollow', readExecutionPermit: permit } as never)
      expect(openSpy).toHaveBeenCalledWith(file, expect.any(Number))
      const flags = openSpy.mock.calls.find(([openedPath]) => openedPath === file)?.[1]
      expect(typeof flags).toBe('number')
      expect((flags as number) & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW)
      if (result.ok) await result.fileHandle.close()
    } finally {
      openSpy.mockRestore()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('许可路径在打开前被替换为符号链接时以机制拒绝终止', async () => {
    if (!fsConstants.O_NOFOLLOW) return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-permit-symlink-race-'))
    try {
      const file = path.join(dir, 'a.txt')
      const replacement = path.join(dir, 'replacement.txt')
      await fs.writeFile(file, 'approved')
      await fs.writeFile(replacement, 'replacement')
      const st = await fs.stat(file)
      const input = { path: file }
      const permit = buildReadExecutionPermit({ requestId: 'r-symlink', toolUseId: 't-symlink', toolName: 'read_file', input, facts: [{ factId: 'f-symlink', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: st.dev, ino: st.ino, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs } }] })
      await fs.unlink(file)
      await fs.symlink(replacement, file)
      await expect(resolveReadPermitTarget('read_file', input, { requestId: 'r-symlink', toolUseId: 't-symlink', readExecutionPermit: permit } as never)).resolves.toEqual({ ok: false, caseId: 'read-target-symlink-changed', failureClass: 'mechanism', factId: 'f-symlink' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
