import { describe, expect, it } from 'vitest'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import {
  formatToolLabel,
  formatToolLabelTitle,
  getToolDescription,
  pathBasename,
  shellToolCompletedLabel,
  shouldAutoExpandShellToolRow
} from './toolCallDisplay'

describe('pathBasename', () => {
  it('returns filename from posix path', () => {
    expect(pathBasename('src/renderer/App.tsx')).toBe('App.tsx')
  })

  it('returns filename from windows path', () => {
    expect(pathBasename('SpaceAssistant\\src\\renderer\\App.tsx')).toBe('App.tsx')
  })
})

describe('formatToolLabel', () => {
  it('shows basename for read_file', () => {
    expect(formatToolLabel('read_file', { path: 'docs/requirement/file-pane-tree-requirement.md' })).toBe(
      'file-pane-tree-requirement.md'
    )
  })

  it('shows basename for list_directory', () => {
    expect(formatToolLabel('list_directory', { path: 'src/renderer/components' })).toBe('components')
  })
})

describe('formatToolLabelTitle', () => {
  it('keeps full path in title for list_directory', () => {
    expect(formatToolLabelTitle('list_directory', { path: 'src/renderer/components' })).toBe('src/renderer/components')
  })
})

describe('getToolDescription', () => {
  it('returns chinese description for builtin tools', () => {
    expect(getToolDescription('read_file')).toBe('读取文件内容（大文件可用 offset/limit 分段）')
    expect(getToolDescription('grep')).toBe('在工作目录下搜索匹配的文件内容')
  })
})

describe('shouldAutoExpandShellToolRow', () => {
  it('returns true for read-only commands', () => {
    const record: ToolCallRecord = {
      id: 't1',
      toolName: 'run_shell',
      input: { command: 'git status' },
      status: 'completed',
      riskLevel: 'low'
    }
    expect(shouldAutoExpandShellToolRow(record)).toBe(true)
  })

  it('returns false for mutating commands', () => {
    const record: ToolCallRecord = {
      id: 't2',
      toolName: 'run_shell',
      input: { command: 'npm install' },
      status: 'completed',
      riskLevel: 'medium'
    }
    expect(shouldAutoExpandShellToolRow(record)).toBe(false)
  })
})

describe('shellToolCompletedLabel', () => {
  it('returns silent completion label for empty output', () => {
    const record: ToolCallRecord = {
      id: 't3',
      toolName: 'run_shell',
      input: { command: 'git status' },
      status: 'completed',
      riskLevel: 'low',
      result: { success: true, data: { stdout: '', stderr: '', exitCode: 0 } }
    }
    expect(shellToolCompletedLabel(record)).toBe('已完成（无输出）')
  })
})
