import { describe, expect, it } from 'vitest'
import { formatToolLabel, formatToolLabelTitle, getToolDescription, pathBasename } from './toolCallDisplay'

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
    expect(getToolDescription('read_file')).toBe('读取指定文件的完整内容')
    expect(getToolDescription('grep')).toBe('在工作目录下搜索匹配的文件内容')
  })
})
