import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { McpServerForm } from './McpServerForm'
import { newMcpServerDraft } from './mcpDrafts'

describe('McpServerForm public-read trust', () => {
  it('emits the current descriptor hash when the user explicitly trusts a tool as public read-only', () => {
    const descriptorHash = 'a'.repeat(64)
    const draft = { ...newMcpServerDraft(), name: 'Docs', enabledToolNames: ['search'] }
    const onPatch = vi.fn()
    const tool = {
      serverId: draft.id,
      originalName: 'search',
      mappedName: 'mcp_docs_search_12345678',
      description: 'Search public sources',
      inputSchema: { type: 'object' },
      descriptorHash,
      schemaHash: 'b'.repeat(64),
      discoveredAt: new Date().toISOString()
    }
    render(
      <ConfigProvider>
        <App>
          <McpServerForm draft={draft} tools={[tool]} skippedCount={0} testing={false} saving={false} canEnable
            onPatch={onPatch} onTest={vi.fn()} onSave={vi.fn()} onToggleEnabled={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '信任为仅读取公开数据' }))
    expect(onPatch).toHaveBeenCalledWith({ publicReadOnlyTools: { search: descriptorHash } })
  })

  it('emits a separate descriptor-bound account-use authorization when explicitly selected', () => {
    const descriptorHash = 'a'.repeat(64)
    const draft = { ...newMcpServerDraft(), name: 'Docs', enabledToolNames: ['search'] }
    const onPatch = vi.fn()
    const tool = {
      serverId: draft.id,
      originalName: 'search',
      mappedName: 'mcp_docs_search_12345678',
      description: 'Search public sources',
      inputSchema: { type: 'object' },
      descriptorHash,
      schemaHash: 'b'.repeat(64),
      discoveredAt: new Date().toISOString()
    }
    render(
      <ConfigProvider>
        <App>
          <McpServerForm draft={draft} tools={[tool]} skippedCount={0} testing={false} saving={false} canEnable
            onPatch={onPatch} onTest={vi.fn()} onSave={vi.fn()} onToggleEnabled={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '允许此连接账户调用' }))
    expect(onPatch).toHaveBeenCalledWith({ accountAuthorizedTools: { search: descriptorHash } })
    expect(onPatch).not.toHaveBeenCalledWith({ publicReadOnlyTools: { search: descriptorHash } })
  })

  it('does not let the user mark a disabled tool or a descriptor without a host hash', () => {
    const draft = { ...newMcpServerDraft(), name: 'Docs', enabledToolNames: [] }
    const tool = {
      serverId: draft.id,
      originalName: 'search',
      mappedName: 'mcp_docs_search_12345678',
      description: 'Search public sources',
      inputSchema: { type: 'object' },
      discoveredAt: new Date().toISOString()
    }
    const onPatch = vi.fn()
    render(
      <ConfigProvider>
        <App>
          <McpServerForm draft={draft} tools={[tool]} skippedCount={0} testing={false} saving={false} canEnable
            onPatch={onPatch} onTest={vi.fn()} onSave={vi.fn()} onToggleEnabled={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    const trustLabel = screen.getByText('信任为仅读取公开数据').closest('label')
    const accountLabel = screen.getByText('允许此连接账户调用').closest('label')
    expect((trustLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.disabled).toBe(true)
    expect((accountLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.disabled).toBe(true)
  })
})
