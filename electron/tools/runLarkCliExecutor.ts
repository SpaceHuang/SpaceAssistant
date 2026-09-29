import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'
import { assertSafeLarkCliArgs } from '../feishu/larkCliSecurity'
import { parseLarkCliError } from '../feishu/larkCliErrors'
import { LarkCliExecutionUncertainError, type LarkCliRunner } from '../feishu/larkCliRunner'
import { logFeishuCliEvent } from '../feishu/feishuCliLogger'
import { isLarkCliWriteOperation } from '../feishu/larkCliSecurity'
import { redactLarkCliArgsForLog } from '../feishu/feishuCliLogFields'
import { getFeishuBundle } from '../feishu/feishuIpc'
import { sanitizeToolErrorString, sanitizeToolOutput, toToolUserError } from './toolUserErrors'

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
        error: 'LARK_INPUT_INVALID',
        userMessage: toToolUserError(e, { toolName: 'run_lark_cli' }),
        data: { processResult: null, status: 'validation_failed' },
        duration: Date.now() - started
      }
    }

    const runner = ctx.larkCliRunner as LarkCliRunner | undefined
    if (!runner) {
      return { success: false, error: 'LARK_RUNNER_UNAVAILABLE', userMessage: 'LarkCliRunner 未初始化', data: { processResult: null, status: 'dependency_unavailable' }, duration: Date.now() - started }
    }

    const timeoutSec =
      typeof input.timeout === 'number' && input.timeout > 0
        ? input.timeout
        : ctx.feishuConfig?.larkCliDefaultTimeoutSec ?? 120

    const r = await runner.run({
      args,
      ...(ctx.preparedLarkCliExecutable ? { resolvedExecutable: ctx.preparedLarkCliExecutable } : {}),
      timeoutSec,
      onStdout: (t) => ctx.sendProgress('lark-cli', t.slice(-4000)),
      signal: ctx.signal
    })

    if (r.cancelledBeforeStart) {
      return {
        success: false,
        error: 'LARK_CANCELLED_BEFORE_START',
        userMessage: 'lark-cli 在启动前已取消',
        data: { processResult: null, status: 'cancelled_before_start' },
        duration: Date.now() - started
      }
    }
    if (ctx.signal.aborted || r.timedOut) throw new LarkCliExecutionUncertainError()

    const durationMs = Date.now() - started
    const stdoutSafe = sanitizeToolOutput(r.stdout, 'run_lark_cli').text
    const stderrSafe = sanitizeToolOutput(r.stderr, 'run_lark_cli').text
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
      return { success: false, error: 'LARK_TIMEOUT', userMessage: 'lark-cli 执行超时', data: { stdout: stdoutSafe, stderr: stderrSafe, status: 'timed_out', terminationReason: 'timeout' }, duration: durationMs }
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
        error: 'LARK_PROCESS_EXIT',
        userMessage: sanitizeToolErrorString(parsed.message, 'run_lark_cli'),
        data: { stdout: stdoutSafe, stderr: stderrSafe, hint: parsed.hint, status: 'failed', exitCode: r.exitCode, terminationReason: 'process_exit' },
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
      data: { stdout: stdoutSafe, stderr: stderrSafe, status: 'succeeded', exitCode: r.exitCode, terminationReason: 'process_exit' },
      duration: durationMs
    }
  }
}
