import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import type { McpServerProfile } from '../../../shared/mcpTypes'
import { McpSettingsTab } from './McpSettingsTab'

const SAVED_SERVER: McpServerProfile = {
  id: 'server-1',
  name: 'GitHub',
  enabled: false,
  transport: 'stdio',
  timeoutSec: 60,
  auth: { mode: 'none', secretPresent: false },
  stdio: { command: 'node', args: ['server.js'], env: [] },
  enabledToolNames: [],
  toolConfirmPolicy: 'always',
  status: 'untested',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z'
}

describe('McpSettingsTab', () => {
  const mcpList = vi.fn()
  const mcpSaveProfiles = vi.fn()
  const mcpTestConnection = vi.fn()
  const mcpDeleteServer = vi.fn()
  const mcpClearSecret = vi.fn()
  const mcpGetDiagnostics = vi.fn()
  const mcpClearDiagnostics = vi.fn()

  beforeEach(() => {
    mcpList.mockResolvedValue({ servers: [], toolCaches: {} })
    mcpSaveProfiles.mockResolvedValue({ servers: [] })
    mcpTestConnection.mockResolvedValue({
      ok: true,
      serverName: 'test-server',
      protocolVersion: '2025-06-18',
      capabilities: {},
      tools: [
        {
          serverId: 'new-1',
          originalName: 'hello',
          mappedName: 'mcp_new_hello_12345678',
          description: 'says hello',
          inputSchema: {},
          discoveredAt: new Date().toISOString()
        }
      ],
      skipped: []
    })
    mcpDeleteServer.mockResolvedValue({ ok: true })
    mcpClearSecret.mockResolvedValue({ servers: [] })
    mcpGetDiagnostics.mockResolvedValue({ diagnostics: [] })
    mcpClearDiagnostics.mockResolvedValue({ ok: true })
    window.api = {
      ...window.api,
      mcpList,
      mcpSaveProfiles,
      mcpTestConnection,
      mcpDeleteServer,
      mcpClearSecret,
      mcpGetDiagnostics,
      mcpClearDiagnostics,
      mcpRefreshTools: vi.fn()
    } as typeof window.api
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  function renderTab() {
    return render(
      <ConfigProvider>
        <App>
          <McpSettingsTab active open />
        </App>
      </ConfigProvider>
    )
  }

  it('loads and shows stored servers with command summary', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {
        'server-1': {
          tools: [],
          protocolVersion: '2025-06-18',
          discoveredAt: new Date().toISOString()
        }
      }
    })
    renderTab()
    expect(await screen.findByText('GitHub')).toBeTruthy()
    expect(screen.getByText(/命令：node/)).toBeTruthy()
    expect(mcpList).toHaveBeenCalledTimes(1)
  })

  it('adds a server draft and saves via mcpSaveProfiles', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    expect(await screen.findByText('未命名服务')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalledTimes(1))
    const payload = mcpSaveProfiles.mock.calls[0]![0] as { servers: Array<{ name: string; transport: string }> }
    expect(payload.servers).toHaveLength(1)
    expect(payload.servers[0]!.transport).toBe('stdio')
  })

  it('tests a connection and displays discovered tools', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '展开' }))
    fireEvent.click(await screen.findByRole('button', { name: '测试并刷新' }))
    await waitFor(() => expect(mcpTestConnection).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('hello')).toBeTruthy()
    expect(screen.getByText(/mcp_new_hello_/)).toBeTruthy()
  })

  it('requires confirmation before deleting a server', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    const deleteButton = await screen.findByRole('button', { name: '删除' })
    fireEvent.click(deleteButton)
    expect((await screen.findAllByText('删除 MCP 服务')).length).toBeGreaterThan(0)
    expect(mcpDeleteServer).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: /确定|OK/ }))
    await waitFor(() => expect(mcpDeleteServer).toHaveBeenCalledTimes(1))
    expect(mcpDeleteServer).toHaveBeenCalledWith({ serverId: 'server-1' })
  })

  it('opens diagnostics drawer with sanitized entries', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    mcpGetDiagnostics.mockResolvedValue({
      diagnostics: [{ id: 'd1', code: 'init_failed', message: 'boom', occurredAt: new Date().toISOString() }]
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '最近错误' }))
    await waitFor(() => expect(mcpGetDiagnostics).toHaveBeenCalledWith({ serverId: 'server-1' }))
    expect(await screen.findByText('init_failed')).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })
})
