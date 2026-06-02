/** 工具调用单行摘要与图标映射（轻量活动流展示） */

import type { ToolCallRecord } from '../../../shared/domainTypes'
import { isShellReadOnlyCommand, isShellSilentResult } from '../../../shared/shellToolDisplay'

const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_directory'])
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file'])

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

export function getToolDescription(toolName: string): string {
  switch (toolName) {
    case 'grep':
      return '在工作目录下搜索匹配的文件内容'
    case 'read_file':
      return '读取指定文件的完整内容'
    case 'list_directory':
      return '列出目录下的文件和子目录'
    case 'edit_file':
      return '通过字符串替换编辑文件'
    case 'write_file':
      return '将完整内容写入文件'
    case 'run_script':
      return '执行 Python 脚本'
    case 'run_shell':
      return '在会话工作目录下执行 shell 命令'
    case 'browser':
      return '在隔离浏览器中访问网页'
    case 'browser_detect':
      return '检测 browser 工具依赖是否就绪'
    default:
      return `调用工具：${toolName}`
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

export function formatToolLabel(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      return pattern ? `在工作区搜索 '${pattern}'` : '在工作区搜索'
    }
    case 'read_file':
      return typeof input.path === 'string' ? pathBasename(input.path) : '读取文件'
    case 'list_directory':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : '列出目录'
    case 'edit_file':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : '编辑文件'
    case 'write_file':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : '写入文件'
    case 'run_script':
      return '运行脚本'
    case 'run_shell': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (!cmd) return '运行命令'
      return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd
    }
    case 'browser':
      return 'browser'
    case 'browser_detect':
      return '检测浏览器依赖'
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
export function shellToolCompletedLabel(record: ToolCallRecord): string | undefined {
  if (record.toolName !== 'run_shell' || record.status !== 'completed') return undefined
  if (isShellSilentResult(record.result?.data)) return '已完成（无输出）'
  return undefined
}
