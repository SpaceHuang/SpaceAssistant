import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { cleanupOrphanProcess } from './orphanProcessCleanup'

describe('cleanupOrphanProcess', () => {
  const nodeExecutable = process.env.npm_node_execpath ?? process.execPath
  it('owner token 匹配时终止真实 detached 进程组并取得 cleaned evidence', async () => {
    const token = `orphan-test-${process.pid}-${Date.now()}`
    const child = spawn(nodeExecutable, ['-e', 'setInterval(() => {}, 1000)', token], { detached: process.platform === 'darwin', stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject) })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const result = await cleanupOrphanProcess({ pid: child.pid!, processGroupId: process.platform === 'darwin' ? child.pid : undefined, ownerToken: token })
    expect(result).toBe('cleaned')
  })

  it('owner token 不匹配时不得终止目标进程', async () => {
    const child = spawn(nodeExecutable, ['-e', 'setInterval(() => {}, 1000)', 'real-owner'], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject) })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(cleanupOrphanProcess({ pid: child.pid!, ownerToken: 'wrong-owner' })).resolves.toBe('not-owned')
    child.kill('SIGKILL')
  })
})
