/** run_shell 在 IM 远程会话中被拦截时的 tool_result 文案 */
export const SHELL_REMOTE_DISABLED_ERROR =
  '远程指令不允许执行本地 shell 命令。请在桌面端 SpaceAssistant 中确认后执行。'

/** @deprecated 使用 SHELL_REMOTE_DISABLED_ERROR */
export const SHELL_FEISHU_REMOTE_DISABLED_ERROR = SHELL_REMOTE_DISABLED_ERROR

import type { ShellTerminalScrollback } from './domainTypes'

/** run_shell 工具执行结果（result.data 结构） */
export interface ShellResultData {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  interrupted?: boolean
  truncated?: boolean
  persistedOutputPath?: string
  shell?: string
  exitCodeHint?: string
  /** terminal 模式完成态 UI scrollback */
  terminalScrollback?: ShellTerminalScrollback
}

export function parseShellResultData(data: unknown): ShellResultData | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as ShellResultData
  return {
    stdout: typeof d.stdout === 'string' ? d.stdout : undefined,
    stderr: typeof d.stderr === 'string' ? d.stderr : undefined,
    exitCode: typeof d.exitCode === 'number' || d.exitCode === null ? d.exitCode : undefined,
    interrupted: typeof d.interrupted === 'boolean' ? d.interrupted : undefined,
    truncated: typeof d.truncated === 'boolean' ? d.truncated : undefined,
    persistedOutputPath: typeof d.persistedOutputPath === 'string' ? d.persistedOutputPath : undefined,
    shell: typeof d.shell === 'string' ? d.shell : undefined,
    exitCodeHint: typeof d.exitCodeHint === 'string' ? d.exitCodeHint : undefined,
    terminalScrollback:
      d.terminalScrollback && typeof d.terminalScrollback === 'object'
        ? (d.terminalScrollback as ShellTerminalScrollback)
        : undefined
  }
}

export function hasTerminalScrollback(data: ShellResultData | undefined): boolean {
  if (!data?.terminalScrollback) return false
  const s = data.terminalScrollback
  return Boolean(s.serialized?.trim() || s.ansiText?.trim() || s.plainText?.trim())
}

export function hasShellOutput(data: ShellResultData | undefined): boolean {
  if (!data) return false
  return Boolean(String(data.stdout ?? '').trim() || String(data.stderr ?? '').trim())
}

export function isShellReadOnlyCommand(command: string): boolean {
  const t = command.trim().toLowerCase()
  if (/^git\s+status\b/.test(t)) return true
  if (/^git\s+diff\s+--stat\b/.test(t)) return true
  if (/^(ls|dir)(\s|$)/.test(t)) return true
  if (/^npm\s+-v\b/.test(t)) return true
  if (/^node\s+-v\b/.test(t)) return true
  return false
}

export function isShellSilentResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as { exitCode?: unknown; stdout?: unknown; stderr?: unknown }
  return d.exitCode === 0 && !String(d.stdout ?? '').trim() && !String(d.stderr ?? '').trim()
}
