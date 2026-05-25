import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'
import { assertSafeLarkCliArgs } from '../feishu/larkCliSecurity'
import { parseLarkCliError } from '../feishu/larkCliErrors'
import type { LarkCliRunner } from '../feishu/larkCliRunner'

export const runLarkCliExecutor: ToolExecutor = {
  name: 'run_lark_cli',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    let args: string[]
    try {
      args = assertSafeLarkCliArgs(input.args)
    } catch (e) {
      return { success: false, error: String(e), duration: Date.now() - started }
    }

    const runner = ctx.larkCliRunner as LarkCliRunner | undefined
    if (!runner) {
      return { success: false, error: 'LarkCliRunner 未初始化', duration: Date.now() - started }
    }

    const timeoutSec =
      typeof input.timeout === 'number' && input.timeout > 0
        ? input.timeout
        : ctx.feishuConfig?.larkCliDefaultTimeoutSec ?? 120

    const r = await runner.run({
      args,
      timeoutSec,
      onStdout: (t) => ctx.sendProgress('lark-cli', t.slice(-4000)),
      signal: ctx.signal
    })

    if (r.timedOut) {
      return { success: false, error: 'lark-cli 执行超时', duration: Date.now() - started }
    }
    if (r.exitCode !== 0) {
      const parsed = parseLarkCliError(r.stderr)
      return {
        success: false,
        error: parsed.message,
        data: { stdout: r.stdout, stderr: r.stderr, hint: parsed.hint },
        duration: Date.now() - started
      }
    }
    return {
      success: true,
      data: { stdout: r.stdout, stderr: r.stderr },
      duration: Date.now() - started
    }
  }
}
