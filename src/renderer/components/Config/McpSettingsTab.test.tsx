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
    // 新建服务直接打开编辑弹窗
    const nameInput = (await screen.findByPlaceholderText('例如 GitHub')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'GitHub' } })

    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalledTimes(1))
    const payload = mcpSaveProfiles.mock.calls[0]![0] as { servers: Array<{ name: string; transport: string }> }
    expect(payload.servers).toHaveLength(1)
    expect(payload.servers[0]!.transport).toBe('stdio')
  })

  it('blocks saving when the server name is empty', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    // 新建草稿名称为空，直接保存
    fireEvent.click(await screen.findByRole('button', { name: '保存并应用' }))
    expect(await screen.findByText('服务名称不能为空')).toBeTruthy()
    expect(mcpSaveProfiles).not.toHaveBeenCalled()
  })

  it('tests a connection and displays discovered tools', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(mcpTestConnection).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('hello')).toBeTruthy()
    expect(screen.getByText(/mcp_new_hello_/)).toBeTruthy()
  })

  it('surfaces stdio validation errors only when the connection fails', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    mcpTestConnection.mockResolvedValue({
      ok: false,
      code: 'invalid-command',
      message: 'Windows 下该命令为脚本垫片（.cmd/.bat），不可直接启动；请改用 node <入口.js>、python、docker 等写法'
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(mcpTestConnection).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Windows 下该命令为脚本垫片/)).toBeTruthy()
  })

  it('opens the editor prefilled with the saved server', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const nameInput = (await screen.findByPlaceholderText('例如 GitHub')) as HTMLInputElement
    expect(nameInput.value).toBe('GitHub')
    expect(screen.getByText('编辑服务')).toBeTruthy()
    expect(screen.queryByText('基础信息')).toBeNull()
    expect(screen.getByText('连接方式')).toBeTruthy()
    expect(screen.queryByText('认证')).toBeNull()
    expect(screen.getByText('工具与权限')).toBeTruthy()
  })

  it('keeps auth options inside the Streamable HTTP tab only', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))

    // stdio tab 激活时没有认证方式
    expect(screen.queryByText('认证方式')).toBeNull()

    fireEvent.click(await screen.findByRole('tab', { name: '流式HTTP' }))
    expect(await screen.findByText('认证方式')).toBeTruthy()
    expect(screen.getByText('MCP Endpoint')).toBeTruthy()
  })

  it('orders sections as common params → connection tabs → tools', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))

    const common = screen.getByText('公共参数')
    const conn = screen.getByText('连接方式')
    const tools = screen.getByText('工具与权限')
    expect(common.compareDocumentPosition(conn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(conn.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(common.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps common params collapsed with a value summary and expands on demand', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))

    expect(await screen.findByText(/60 秒 · 始终确认/)).toBeTruthy()
    expect(screen.queryByText('调用超时（秒）')).toBeNull()

    fireEvent.click(screen.getByText('公共参数'))
    expect(await screen.findByText('调用超时（秒）')).toBeTruthy()
  })

  it('asks for confirmation when closing the editor with unsaved changes', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const nameInput = (await screen.findByPlaceholderText('例如 GitHub')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'GitHub 2' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect((await screen.findAllByText('放弃未保存的 MCP 草稿？')).length).toBeGreaterThan(0)
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
