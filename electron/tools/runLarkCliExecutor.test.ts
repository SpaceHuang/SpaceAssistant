import { describe, expect, it, vi } from 'vitest'
vi.mock('../feishu/feishuIpc', () => ({ getFeishuBundle: () => null }))
import { runLarkCliExecutor } from './runLarkCliExecutor'

function ctx(runner: unknown, signal: AbortSignal = new AbortController().signal) {
  return {
    requestId: 'r', toolUseId: 't', sessionId: 's', workDir: process.cwd(), userDataDir: '/tmp',
    signal, sendProgress: vi.fn(), fileStateCache: {} as never,
    toolsConfig: {} as never, larkCliRunner: runner
  } as never
}

describe('run_lark_cli result contract', () => {
  it('非零退出保留 stderr、exitCode 与稳定错误码', async () => {
    const result = await runLarkCliExecutor.execute({ args: ['doc', 'get'] }, ctx({
      run: vi.fn().mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'permission denied', timedOut: false })
    }))
    expect(result).toMatchObject({ success: false, error: 'LARK_PROCESS_EXIT', data: { status: 'failed', exitCode: 2, stderr: 'permission denied' } })
  })

  it('runner 缺失时显式返回无进程结果', async () => {
    const result = await runLarkCliExecutor.execute({ args: ['doc', 'get'] }, ctx(undefined))
    expect(result).toMatchObject({ success: false, error: 'LARK_RUNNER_UNAVAILABLE', data: { processResult: null } })
  })

  it('runner 已启动后收到 abort 时拒绝为不确定副作用', async () => {
    const controller = new AbortController()
    const runner = { run: vi.fn(async () => {
      controller.abort()
      return { exitCode: 143, stdout: '', stderr: 'terminated', timedOut: false }
    }) }

    await expect(runLarkCliExecutor.execute({ args: ['doc', 'create'] }, ctx(runner, controller.signal)))
      .rejects.toMatchObject({ name: 'LarkCliExecutionUncertainError' })
    expect(runner.run).toHaveBeenCalledOnce()
  })

  it('runner 启动后超时也拒绝为不确定副作用', async () => {
    const runner = { run: vi.fn().mockResolvedValue({
      exitCode: 143, stdout: 'partial output', stderr: '', timedOut: true
    }) }

    await expect(runLarkCliExecutor.execute({ args: ['doc', 'create'] }, ctx(runner)))
      .rejects.toMatchObject({ name: 'LarkCliExecutionUncertainError' })
    expect(runner.run).toHaveBeenCalledOnce()
  })

  it('runner 在启动前观察到 abort 时返回确定的未派发结果', async () => {
    const controller = new AbortController()
    controller.abort()
    const runner = { run: vi.fn().mockResolvedValue({
      exitCode: 1, stdout: '', stderr: '', timedOut: false, cancelledBeforeStart: true
    }) }

    await expect(runLarkCliExecutor.execute({ args: ['doc', 'create'] }, ctx(runner, controller.signal)))
      .resolves.toMatchObject({ success: false, error: 'LARK_CANCELLED_BEFORE_START', data: { processResult: null } })
    expect(runner.run).toHaveBeenCalledOnce()
  })

  it('遮盖 CLI 输出中的 token，路径与错误上下文保留', async () => {
    const result = await runLarkCliExecutor.execute({ args: ['doc', 'get'] }, ctx({
      run: vi.fn().mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'ValueError /tmp/x API_KEY=secret', timedOut: false })
    }))
    expect(String((result.data as { stderr: string }).stderr)).toContain('ValueError')
    expect(String((result.data as { stderr: string }).stderr)).not.toContain('API_KEY=secret')
    expect(String((result.data as { stderr: string }).stderr)).toContain('/tmp/x')
  })
})
