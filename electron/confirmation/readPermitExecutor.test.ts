import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { buildReadExecutionPermit } from './readExecutionPermit'
import { resolveReadPermitTarget } from './readPermitExecutor'

describe('resolveReadPermitTarget', () => {
  it('目录 permit 仅返回身份匹配的 direct-entries 目标', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-directory-permit-'))
    try {
      const input = { path: dir }
      const stat = await fs.stat(dir)
      const permit = buildReadExecutionPermit({
        requestId: 'r-dir', toolUseId: 't-dir', toolName: 'list_directory', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs } }]
      })
      await expect(resolveReadPermitTarget('list_directory', input, { requestId: 'r-dir', toolUseId: 't-dir', readExecutionPermit: permit } as never)).resolves.toEqual({ ok: true, path: dir })
      const badPermit = buildReadExecutionPermit({
        requestId: 'r-dir', toolUseId: 't-dir', toolName: 'list_directory', input,
        facts: [{ factId: `fact-${dir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: dir, zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size + 1, mtimeMs: stat.mtimeMs } }]
      })
      await expect(resolveReadPermitTarget('list_directory', input, { requestId: 'r-dir', toolUseId: 't-dir', readExecutionPermit: badPermit } as never)).resolves.toMatchObject({ ok: false, caseId: 'read-directory-identity-changed', failureClass: 'mechanism' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('按绑定许可返回目标路径，并拒绝变更的请求或输入', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-permit-exec-'))
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-permit-exec-'))
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
