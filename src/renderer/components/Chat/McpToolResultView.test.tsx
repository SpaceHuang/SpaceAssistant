import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { McpToolResultView } from './McpToolResultView'

describe('McpToolResultView', () => {
  it('does not mount the full body for huge results', () => {
    render(<McpToolResultView display={{ isEmpty: false, text: '完整正文不应挂载', displayMode: 'huge', blocks: [{ kind: 'text', text: '完整正文不应挂载' }] }} />)
    expect(screen.queryByText('完整正文不应挂载')).toBeNull()
    expect(screen.getByText('结果过大，仅显示摘要')).toBeTruthy()
  })

  it('renders only validated image previews and keeps invalid images as metadata', () => {
    render(<McpToolResultView display={{ isEmpty: false, text: '', blocks: [
      { kind: 'image', mimeType: 'image/png', byteLength: 4, data: 'AAAA', previewable: true },
      { kind: 'image', mimeType: 'image/png', byteLength: 4, previewable: false }
    ] }} />)
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getAllByText('图片结果 · image/png · 4 bytes')).toHaveLength(2)
  })

  it('uses the constrained ChatMarkdown path for markdown-like text', () => {
    const { container } = render(<McpToolResultView display={{ isEmpty: false, text: '## 标题\n\n- 条目', displayMode: 'short', blocks: [{ kind: 'text', text: '## 标题\n\n- 条目' }] }} messageId="message-1" toolUseId="tool-1" />)
    expect(screen.getByRole('heading', { name: '标题' })).toBeTruthy()
    expect(screen.getByText('条目')).toBeTruthy()
    expect(container.querySelector('[data-search-fragment-id="message-1|tool-result-markdown-text:tool-1:0:0"]')).toBeTruthy()
  })

  it('renders JSON text as a field table', () => {
    const { container } = render(<McpToolResultView display={{ isEmpty: false, text: '{"hot":{"title":"x"}}', displayMode: 'short', blocks: [{ kind: 'text', text: '{"hot":{"title":"x"}}' }] }} messageId="message-json" toolUseId="tool-json" />)
    expect(container.querySelector('.mcp-json-table')?.textContent).toContain('title')
    expect(container.querySelector('.mcp-json-table')?.textContent).toContain('x')
  })

  it('renders structured JSON as a field table with deeper values kept compact', () => {
    const { container } = render(<McpToolResultView display={{ isEmpty: false, text: '', structured: { ok: true, meta: { queryId: '42', nested: { hidden: true } }, rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Lin' }] }, structuredText: '{...}', displayMode: 'short', blocks: [] }} />)
    const table = container.querySelector('.mcp-json-table')
    expect(table).toBeTruthy()
    expect(table?.textContent).toContain('meta')
    expect(table?.textContent).toContain('queryId')
    expect(table?.textContent).toContain('rows')
    expect(table?.textContent).toContain('Ada')
    expect(table?.textContent).toContain('"hidden": true')
    expect(screen.queryByRole('button', { name: '查看 JSON 详情' })).toBeNull()
  })

  it('renders a JSON object returned as text in the same table view', () => {
    const { container } = render(<McpToolResultView display={{ isEmpty: false, text: '{"ok":true,"ids":{"queueId":"q-1"}}', displayMode: 'short', blocks: [] }} />)
    expect(container.querySelector('.mcp-json-table')?.textContent).toContain('queueId')
    expect(container.querySelector('.mcp-json-table')?.textContent).toContain('q-1')
    expect(container.querySelector('.sa-shiki-block')).toBeNull()
  })

  it('shows a 20-line preview before expanding medium results', async () => {
    const text = Array.from({ length: 30 }, (_, index) => `line-${index}`).join('\n')
    render(<McpToolResultView display={{ isEmpty: false, text, displayMode: 'medium', blocks: [{ kind: 'text', text }] }} />)
    const preview = screen.getByRole('button', { name: /复制结果/ }).parentElement?.querySelector('pre')
    expect(preview?.textContent).toContain('line-0')
    expect(preview?.textContent).not.toContain('line-29')
    fireEvent.click(screen.getByRole('button', { name: /展开全部/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /复制结果/ }).parentElement?.querySelector('pre')?.textContent).toContain('line-29'))
  })

  it('shows a non-blocking hint when opening an artifact fails', async () => {
    const open = vi.fn().mockResolvedValue({ ok: false, error: 'INVALID_PATH' })
    window.api.mcpOpenResultArtifact = open
    render(<McpToolResultView display={{ isEmpty: false, text: 'large', blocks: [{ kind: 'text', text: 'large' }], artifactId: 'artifact-mcp-' + 'a'.repeat(64), artifactOwner: { sessionId: 's', assistantMessageId: 'm', toolUseId: 't' } }} />)
    fireEvent.click(screen.getByRole('button', { name: /打开完整内容|Open full result/ }))
    await waitFor(() => expect(screen.getByText(/无法打开完整内容|Failed to open full content/)).toBeTruthy())
    expect(open).toHaveBeenCalledOnce()
  })
})
