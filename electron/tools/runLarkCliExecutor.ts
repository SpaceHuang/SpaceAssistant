import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'
import { assertSafeLarkCliArgs } from '../feishu/larkCliSecurity'
import { parseLarkCliError } from '../feishu/larkCliErrors'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import { logFeishuCliEvent } from '../feishu/feishuCliLogger'
import { isLarkCliWriteOperation } from '../feishu/larkCliSecurity'
import { redactLarkCliArgsForLog } from '../feishu/feishuCliLogFields'
import { getFeishuBundle } from '../feishu/feishuIpc'
import { sanitizeToolErrorString, toToolUserError } from './toolUserErrors'

export const runLarkCliExecutor: ToolExecutor = {
  name: 'run_lark_cli',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    let args: string[]
    try {
      args = assertSafeLarkCliArgs(input.args)
    } catch (e) {
      logFeishuCliEvent('warn', 'feishu.tool.run_lark_cli.rejected', { error: String(e) })
      return {
        success: false,
        error: toToolUserError(e, { toolName: 'run_lark_cli' }),
        duration: Date.now() - started
      }
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

    const durationMs = Date.now() - started
    const { argsRedacted } = redactLarkCliArgsForLog(args)
    const writeOp = isLarkCliWriteOperation(args)
    const shouldAudit = ctx.remoteContext?.source === 'feishu' || Boolean(ctx.feishuConfig)

    if (r.timedOut) {
      logFeishuCliEvent('warn', 'feishu.tool.run_lark_cli', {
        sessionId: ctx.sessionId,
        argsRedacted,
        success: false,
        writeOp,
        durationMs,
        error: 'lark-cli 执行超时'
      })
      if (shouldAudit) {
        void getFeishuBundle()?.auditLogger.append({
          type: 'lark_cli',
          sessionId: ctx.sessionId,
          args,
          success: false,
          writeOp
        })
      }
      return { success: false, error: 'lark-cli 执行超时', duration: durationMs }
    }

    if (r.exitCode !== 0) {
      const parsed = parseLarkCliError(r.stderr)
      logFeishuCliEvent('warn', 'feishu.tool.run_lark_cli', {
        sessionId: ctx.sessionId,
        argsRedacted,
        success: false,
        writeOp,
        durationMs,
        error: parsed.message
      })
      if (shouldAudit) {
        void getFeishuBundle()?.auditLogger.append({
          type: 'lark_cli',
          sessionId: ctx.sessionId,
          args,
          success: false,
          writeOp
        })
      }
      return {
        success: false,
        error: sanitizeToolErrorString(parsed.message, 'run_lark_cli'),
        data: { stdout: r.stdout, stderr: r.stderr, hint: parsed.hint },
        duration: durationMs
      }
    }
    logFeishuCliEvent('info', 'feishu.tool.run_lark_cli', {
      sessionId: ctx.sessionId,
      argsRedacted,
      success: true,
      writeOp,
      durationMs
    })
    if (shouldAudit) {
      void getFeishuBundle()?.auditLogger.append({
        type: 'lark_cli',
        sessionId: ctx.sessionId,
        args,
        success: true,
        writeOp
      })
    }
    return {
      success: true,
      data: { stdout: r.stdout, stderr: r.stderr },
      duration: durationMs
    }
  }
}
