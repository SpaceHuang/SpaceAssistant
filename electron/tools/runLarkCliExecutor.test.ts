import { describe, expect, it, vi } from 'vitest'
vi.mock('../feishu/feishuIpc', () => ({ getFeishuBundle: () => null }))
import { runLarkCliExecutor } from './runLarkCliExecutor'

function ctx(runner: unknown) {
  return {
    requestId: 'r', toolUseId: 't', sessionId: 's', workDir: process.cwd(), userDataDir: '/tmp',
    signal: new AbortController().signal, sendProgress: vi.fn(), fileStateCache: {} as never,
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

  it('脱敏 CLI 输出中的 token 与路径，但保留错误上下文', async () => {
    const result = await runLarkCliExecutor.execute({ args: ['doc', 'get'] }, ctx({
      run: vi.fn().mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'ValueError /tmp/x API_KEY=secret', timedOut: false })
    }))
    expect(String((result.data as { stderr: string }).stderr)).toContain('ValueError')
    expect(String((result.data as { stderr: string }).stderr)).not.toContain('API_KEY=secret')
    expect(String((result.data as { stderr: string }).stderr)).toContain('<path:redacted>')
  })
})
