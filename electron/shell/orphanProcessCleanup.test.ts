import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { cleanupOrphanProcess } from './orphanProcessCleanup'

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
})
