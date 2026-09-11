import { describe, expect, it, vi } from 'vitest'
import { getToolExecutor } from './builtinExecutors'

function ctx() {
  return {
    workDir: process.cwd(), userDataDir: '/tmp', requestId: 'r', toolUseId: 't', sessionId: 's',
    sendProgress: vi.fn(), signal: new AbortController().signal, fileStateCache: {} as never,
    toolsConfig: { enabled: true, allowedTools: [], deniedTools: [], scriptTimeout: 5, pythonPath: process.env.PYTHON ?? 'python3' }
  } as never
}

describe('run_script result contract', () => {
  it('失败时保留结构化 stderr 与稳定错误码', async () => {
    const executor = getToolExecutor('run_script')!
    const result = await executor.execute({ code: "import sys; print('ValueError: bad', file=sys.stderr); raise SystemExit(1)" }, ctx())
    expect(result).toMatchObject({ success: false, error: 'SCRIPT_PROCESS_EXIT', data: { status: 'failed', exitCode: 1 } })
    expect(String(result.data && (result.data as { stderr?: string }).stderr)).toContain('ValueError: bad')
  }, 20_000)

  it('成功空 stdout 仍然是 succeeded，不伪造成失败', async () => {
    const executor = getToolExecutor('run_script')!
    const result = await executor.execute({ code: 'pass' }, ctx())
    expect(result).toMatchObject({ success: true, data: { status: 'succeeded', exitCode: 0 } })
  }, 20_000)
})
