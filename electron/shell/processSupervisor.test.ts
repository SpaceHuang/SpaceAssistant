import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { ProcessSupervisor } from './processSupervisor'
import { processTreeKiller } from '../spawnUtil'

describe('ProcessSupervisor', () => {
  it('只有 tree kill verified 才进入 terminated，并且重复 terminate 复用同一结果', async () => {
    const killer = { terminate: vi.fn().mockResolvedValue({ signal: 'SIGTERM', verified: true }) }
    const supervisor = new ProcessSupervisor({} as never, killer)
    const first = supervisor.terminate(5_000)
    const second = supervisor.terminate(5_000)
    await expect(first).resolves.toEqual({ state: 'terminated', signal: 'SIGTERM', treeKillVerified: true })
    await expect(second).resolves.toEqual({ state: 'terminated', signal: 'SIGTERM', treeKillVerified: true })
    expect(killer.terminate).toHaveBeenCalledOnce()
    expect(supervisor.state).toBe('terminated')
  })

  it('cleanup 未在 deadline 内取得 evidence 时进入 termination_failed，不能伪装成 terminated', async () => {
    const killer = { terminate: vi.fn(() => new Promise<{ signal: string; verified: boolean }>(() => undefined)) }
    const supervisor = new ProcessSupervisor({} as never, killer)
    await expect(supervisor.terminate(1)).resolves.toEqual({ state: 'termination_failed', signal: null, treeKillVerified: false })
    expect(supervisor.state).toBe('termination_failed')
    await expect(supervisor.terminate(1)).resolves.toEqual({ state: 'termination_failed', signal: null, treeKillVerified: false })
    expect(killer.terminate).toHaveBeenCalledOnce()
  })

  it('killer 自身失败也收敛为不可验证的 cleanup 结果', async () => {
    const killer = { terminate: vi.fn().mockRejectedValue(new Error('kill failed')) }
    const supervisor = new ProcessSupervisor({} as never, killer)
    await expect(supervisor.terminate()).resolves.toMatchObject({ state: 'termination_failed', treeKillVerified: false })
  })

  it('abort race：deadline 先到达后，迟到的 verified killer 结果不能改写失败终态', async () => {
    let resolveKiller!: (value: { signal: string; verified: boolean }) => void
    const killer = {
      terminate: vi.fn(() => new Promise<{ signal: string; verified: boolean }>((resolve) => { resolveKiller = resolve }))
    }
    const supervisor = new ProcessSupervisor({} as never, killer)
    const result = await supervisor.terminate(1)
    expect(result).toEqual({ state: 'termination_failed', signal: null, treeKillVerified: false })

    resolveKiller({ signal: 'SIGKILL', verified: true })
    await Promise.resolve()
    await expect(supervisor.terminate(1)).resolves.toEqual(result)
    expect(supervisor.state).toBe('termination_failed')
  })

  it('真实子进程：tree cleanup 收到退出 evidence 后进入 terminated 且重复调用幂等', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform === 'darwin'
    })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', reject)
      })
      const supervisor = new ProcessSupervisor(child, processTreeKiller)
      const result = await supervisor.terminate(5_000)
      expect(result.state).toBe('terminated')
      expect(result.treeKillVerified).toBe(true)
      await expect(supervisor.terminate()).resolves.toEqual(result)
      expect(supervisor.state).toBe('terminated')
    } finally {
      if (child.exitCode === null && !child.killed) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }
    }
  })
})
