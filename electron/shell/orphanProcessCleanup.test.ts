import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { cleanupOrphanProcess } from './orphanProcessCleanup'
import { runCommandWithTimeout } from '../spawnUtil'

describe('cleanupOrphanProcess', () => {
  const nodeExecutable = process.env.npm_node_execpath ?? process.execPath
  // 只有 macOS profile 以 detached 方式启动 Shell；Windows/Linux 上的真实身份不带进程组，
  // 因此这里分别覆盖"带进程组"和"仅有 PID"两条终止路径。
  const detached = process.platform === 'darwin'

  async function spawnOwnerProcess(token: string, startDetached: boolean) {
    const child = spawn(nodeExecutable, ['-e', 'setInterval(() => {}, 1000)', token], {
      detached: startDetached,
      stdio: 'ignore'
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    return child
  }

  it('owner token 匹配时终止真实 detached 进程组并取得 cleaned evidence', async () => {
    const token = `orphan-test-${process.pid}-${Date.now()}`
    const child = await spawnOwnerProcess(token, detached)
    const result = await cleanupOrphanProcess({
      pid: child.pid!,
      processGroupId: detached ? child.pid : undefined,
      ownerToken: token
    })
    expect(result).toBe('cleaned')
  })

  it('owner token 不匹配时不得终止目标进程', async () => {
    const child = await spawnOwnerProcess('real-owner', false)
    await expect(cleanupOrphanProcess({ pid: child.pid!, ownerToken: 'wrong-owner' })).resolves.toBe('not-owned')
    child.kill('SIGKILL')
  })

  it('未声明进程组时按 PID 终止目标进程且不波及其他进程', async () => {
    const token = `orphan-no-group-${process.pid}-${Date.now()}`
    const child = await spawnOwnerProcess(token, false)
    await expect(cleanupOrphanProcess({ pid: child.pid!, ownerToken: token })).resolves.toBe('cleaned')
  })

  it('命令行含非 ASCII 时仍能按 owner token 完成归属校验', async () => {
    // 回归 Windows 上按 utf8 解码 PowerShell OEM 输出导致命令行乱码的问题。
    const token = `owner-token-中文-${Date.now()}`
    const child = await spawnOwnerProcess(token, detached)
    await expect(cleanupOrphanProcess({ pid: child.pid!, ownerToken: token })).resolves.toBe('cleaned')
  })

  it('命令行查询不可用时返回 unverified 且不触碰目标进程', async () => {
    // Windows 上 powershell.exe 仍会被系统目录解析到，这里只在 POSIX 覆盖查询工具缺失。
    if (process.platform === 'win32') return
    const token = `orphan-unverified-${process.pid}-${Date.now()}`
    const child = await spawnOwnerProcess(token, false)
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(cleanupOrphanProcess({ pid: child.pid!, ownerToken: token })).resolves.toBe('unverified')
    } finally {
      process.env.PATH = originalPath
    }
    child.kill('SIGKILL')
  })
})

describe('runCommandWithTimeout', () => {
  it('查询命令挂起时按超时收敛，不阻塞调用方', async () => {
    const started = Date.now()
    const result = await runCommandWithTimeout(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 1_000)
    expect(result).toEqual({ completed: false, code: null, stdout: '' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('可执行文件不可用时立即收敛为未完成', async () => {
    const missing = path.join(os.tmpdir(), 'sa-missing-orphan-probe')
    await expect(runCommandWithTimeout(missing, [], 5_000)).resolves.toEqual({ completed: false, code: null, stdout: '' })
  })

  it('命令正常结束时返回退出码与 stdout', async () => {
    const result = await runCommandWithTimeout(
      process.execPath,
      ['-e', "process.stdout.write('orphan-probe-ok')"],
      10_000
    )
    expect(result).toEqual({ completed: true, code: 0, stdout: 'orphan-probe-ok' })
  })
})
