import { describe, expect, it, vi } from 'vitest'
import { ProcessSupervisor } from './processSupervisor'

function fakeProcess(): any { return { pid: 42 } }

describe('ProcessSupervisor', () => {
  it('按 running → terminating → terminated 转换且重复调用共享同一 promise', async () => {
    let resolveKiller!: (value: { signal: string; verified: boolean }) => void
    const terminate = vi.fn(() => new Promise<{ signal: string; verified: boolean }>((resolve) => { resolveKiller = resolve }))
    const supervisor = new ProcessSupervisor(fakeProcess(), { terminate })
    expect(supervisor.state).toBe('running')
    const first = supervisor.terminate(100)
    expect(supervisor.state).toBe('terminating')
    expect(supervisor.terminate()).toBe(first)
    resolveKiller({ signal: 'SIGTERM', verified: true })
    await expect(first).resolves.toEqual({ state: 'terminated', signal: 'SIGTERM', treeKillVerified: true })
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('终止器失败或无法确认时收敛为 termination_failed', async () => {
    const supervisor = new ProcessSupervisor(fakeProcess(), { terminate: async () => ({ signal: 'SIGKILL', verified: false }) })
    await expect(supervisor.terminate()).resolves.toEqual({ state: 'termination_failed', signal: 'SIGKILL', treeKillVerified: false })
    expect(supervisor.state).toBe('termination_failed')
    await expect(supervisor.terminate()).resolves.toEqual({ state: 'termination_failed', signal: 'SIGKILL', treeKillVerified: false })
  })

  it('终止器抛出异常时仍收敛且重复调用复用终态', async () => {
    const supervisor = new ProcessSupervisor(fakeProcess(), {
      terminate: async () => { throw new Error('spawn/kill failure') }
    })
    const first = supervisor.terminate()
    const result = await first
    expect(result).toEqual({ state: 'termination_failed', signal: null, treeKillVerified: false })
    await expect(supervisor.terminate()).resolves.toBe(result)
  })

  it('超过终止 deadline 时返回 termination_failed，不无限等待', async () => {
    const supervisor = new ProcessSupervisor(fakeProcess(), {
      terminate: () => new Promise(() => undefined)
    })
    await expect(supervisor.terminate(10)).resolves.toEqual({
      state: 'termination_failed',
      signal: null,
      treeKillVerified: false
    })
    expect(supervisor.state).toBe('termination_failed')
  })
})
