import { sanitizeForLog } from '../logSanitize'

export const SHELL_COMMAND_LOG_MAX = 2048
export const SHELL_OUTPUT_PREVIEW_MAX = 4096
export const SHELL_DESCRIPTION_LOG_MAX = 500

/** 命令行内联敏感参数脱敏（环境变量名、CLI flag 等） */
export function redactShellCommandForLog(command: string): unknown {
  let s = command
  s = s.replace(/(--?(?:secret|token|password|api[_-]?key|passwd|auth))\s+\S+/gi, '$1 ***')
  s = s.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY|PASSWD))\s*=\s*\S+/gi, '$1=***')
  s = s.replace(/(-u|--user)\s+\S+/gi, '$1 ***')
  return sanitizeForLog(s, { maxStringLength: SHELL_COMMAND_LOG_MAX })
}

export function shellIoPreviewForLog(text: string, prefix: 'stdout' | 'stderr'): Record<string, unknown> {
  const sanitized = sanitizeForLog(text, { maxStringLength: SHELL_OUTPUT_PREVIEW_MAX })
  if (typeof sanitized === 'string') {
    return {
      [`${prefix}Len`]: text.length,
      [`${prefix}Preview`]: sanitized
    }
  }
  const obj = sanitized as { _value: string; _truncated?: boolean; _originalLength?: number }
  return {
    [`${prefix}Len`]: text.length,
    [`${prefix}Preview`]: obj._value,
    ...(obj._truncated
      ? {
          [`${prefix}PreviewTruncated`]: true,
          [`${prefix}OriginalLen`]: obj._originalLength ?? text.length
        }
      : {})
  }
}

/** 将 run_shell 日志字段转为可安全写入 Agent 日志的形态 */
export function preprocessShellLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields }

  if (typeof out.command === 'string') {
    out.commandRedacted = redactShellCommandForLog(out.command)
    delete out.command
  }

  if (typeof out.description === 'string') {
    out.description = sanitizeForLog(out.description, { maxStringLength: SHELL_DESCRIPTION_LOG_MAX })
  }

  if (typeof out.stdout === 'string') {
    Object.assign(out, shellIoPreviewForLog(out.stdout, 'stdout'))
    delete out.stdout
  }

  if (typeof out.stderr === 'string') {
    Object.assign(out, shellIoPreviewForLog(out.stderr, 'stderr'))
    delete out.stderr
  }

  if (typeof out.error === 'string') {
    out.error = sanitizeForLog(out.error, { maxStringLength: SHELL_OUTPUT_PREVIEW_MAX })
  }

  if (typeof out.spawnError === 'string') {
    out.spawnError = sanitizeForLog(out.spawnError, { maxStringLength: SHELL_OUTPUT_PREVIEW_MAX })
  }

  return out
}
