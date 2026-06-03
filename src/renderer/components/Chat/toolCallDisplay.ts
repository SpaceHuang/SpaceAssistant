/** 工具调用单行摘要与图标映射（轻量活动流展示） */

import type { ToolCallRecord } from '../../../shared/domainTypes'
import { isShellReadOnlyCommand, isShellSilentResult } from '../../../shared/shellToolDisplay'
import i18n from '../../i18n'

const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_directory'])
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file'])

export type ToolCallDisplayT = (key: string, options?: Record<string, unknown>) => string

function defaultT(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns: 'chat', ...options })
}

export function isFileTool(toolName: string): boolean {
  return FILE_TOOLS.has(toolName)
}

export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName)
}

export function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

export function getToolDescription(toolName: string, t: ToolCallDisplayT = defaultT): string {
  switch (toolName) {
    case 'grep':
      return t('tool.descriptions.grep')
    case 'read_file':
      return t('tool.descriptions.readFile')
    case 'list_directory':
      return t('tool.descriptions.listDirectory')
    case 'edit_file':
      return t('tool.descriptions.editFile')
    case 'write_file':
      return t('tool.descriptions.writeFile')
    case 'run_script':
      return t('tool.descriptions.runScript')
    case 'run_shell':
      return t('tool.descriptions.runShell')
    case 'browser':
      return t('tool.descriptions.browser')
    case 'browser_detect':
      return t('tool.descriptions.browserDetect')
    default:
      return t('tool.descriptions.invokeTool', { toolName })
  }
}

export function formatToolLabelTitle(toolName: string, input: Record<string, unknown>): string | undefined {
  if (
    (toolName === 'read_file' ||
      toolName === 'list_directory' ||
      toolName === 'edit_file' ||
      toolName === 'write_file') &&
    typeof input.path === 'string' &&
    input.path
  ) {
    return input.path
  }
  if (toolName === 'run_shell' && typeof input.command === 'string' && input.command) {
    return input.command
  }
  return undefined
}

export function formatToolLabel(
  toolName: string,
  input: Record<string, unknown>,
  t: ToolCallDisplayT = defaultT
): string {
  switch (toolName) {
    case 'grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      return pattern ? t('tool.labels.grep.withPattern', { pattern }) : t('tool.labels.grep.default')
    }
    case 'read_file':
      return typeof input.path === 'string' ? pathBasename(input.path) : t('tool.labels.readFile')
    case 'list_directory':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : t('tool.labels.listDirectory')
    case 'edit_file':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : t('tool.labels.editFile')
    case 'write_file':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : t('tool.labels.writeFile')
    case 'run_script':
      return t('tool.labels.runScript')
    case 'run_shell': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (!cmd) return t('tool.labels.runShellEmpty')
      return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd
    }
    case 'browser':
      return 'browser'
    case 'browser_detect':
      return t('tool.labels.browserDetect')
    default:
      return toolName
  }
}

export type ToolIconKind =
  | 'grep'
  | 'read'
  | 'list'
  | 'edit'
  | 'script'
  | 'shell'
  | 'browser'
  | 'lark'
  | 'generic'

export function getToolIconKind(toolName: string): ToolIconKind {
  switch (toolName) {
    case 'grep':
      return 'grep'
    case 'read_file':
      return 'read'
    case 'list_directory':
      return 'list'
    case 'edit_file':
    case 'write_file':
      return 'edit'
    case 'run_script':
      return 'script'
    case 'run_shell':
      return 'shell'
    case 'browser':
    case 'browser_detect':
      return 'browser'
    case 'run_lark_cli':
      return 'lark'
    default:
      return 'generic'
  }
}

/** browser_detect 成功后默认折叠详情（检测摘要见单行标题，详情按需展开） */
export function shouldCollapseBrowserDetectRow(record: ToolCallRecord): boolean {
  return record.toolName === 'browser_detect' && record.status === 'completed' && record.result?.success === true
}

/** 只读 shell 命令（git status 等）完成后默认展开详情 */
export function shouldAutoExpandShellToolRow(record: ToolCallRecord): boolean {
  if (record.toolName !== 'run_shell') return false
  const cmd = typeof record.input.command === 'string' ? record.input.command : ''
  return isShellReadOnlyCommand(cmd)
}

/** 静默命令（exit 0 且无输出）展示专用标签 */
export function shellToolCompletedLabel(record: ToolCallRecord, t: ToolCallDisplayT = defaultT): string | undefined {
  if (record.toolName !== 'run_shell' || record.status !== 'completed') return undefined
  if (isShellSilentResult(record.result?.data)) return t('tool.completedNoOutput')
  return undefined
}
