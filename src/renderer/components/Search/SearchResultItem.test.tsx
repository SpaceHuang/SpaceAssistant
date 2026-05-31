import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { SearchResult } from '../../../shared/domainTypes'
import { SearchResultItem } from './SearchResultItem'

const sessionItem: SearchResult = {
  id: 'msg:m1',
  type: 'session',
  title: '性能讨论',
  preview: '你可以使用 React.memo 来优化',
  sessionId: 's1',
  messageId: 'm1'
}

const fileItem: SearchResult = {
  id: 'file:1',
  type: 'file',
  title: 'src/utils/perf.ts',
  preview: 'export function memoize',
  path: 'src/utils/perf.ts'
}

describe('SearchResultItem', () => {
  it('renders session result with 聊天 tag and preview', () => {
    render(<SearchResultItem item={sessionItem} onClick={vi.fn()} />)
    expect(screen.getByText('聊天')).toBeDefined()
    expect(screen.getByText('性能讨论')).toBeDefined()
    expect(screen.getByText(/React\.memo/)).toBeDefined()
    expect(screen.queryByText('[session]')).toBeNull()
  })

  it('renders file result with 文件 tag and directory auxiliary', () => {
    render(<SearchResultItem item={fileItem} onClick={vi.fn()} />)
    expect(screen.getByText('文件')).toBeDefined()
    expect(screen.getByText(/📂 src\/utils/)).toBeDefined()
    expect(screen.queryByText('[file]')).toBeNull()
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<SearchResultItem item={fileItem} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
