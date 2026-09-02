import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  status: 'untested',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z'
}

const ENV_SERVER: McpServerProfile = {
  ...SAVED_SERVER,
  stdio: {
    command: 'node',
    args: ['server.js'],
    env: [{ key: 'GITHUB_TOKEN', valuePresent: true }]
  }
}

const SSE_SERVER: McpServerProfile = {
  ...SAVED_SERVER,
  transport: 'sse',
  stdio: undefined,
  http: { endpoint: 'https://example.com/sse' }
}

describe('McpSettingsTab', () => {
  const mcpList = vi.fn()
  const mcpSaveProfiles = vi.fn()
  const mcpTestConnection = vi.fn()
  const mcpDeleteServer = vi.fn()
  const mcpClearSecret = vi.fn()
  const mcpGetDiagnostics = vi.fn()
  const mcpClearDiagnostics = vi.fn()
  const mcpRefreshTools = vi.fn()

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
      mcpRefreshTools
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
    const discoveredTool = {
      serverId: 'server-1',
      originalName: 'hello',
      mappedName: 'mcp_new_hello_12345678',
      description: 'says hello',
      inputSchema: {},
      discoveredAt: new Date().toISOString()
    }
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {
        'server-1': {
          tools: [discoveredTool],
          protocolVersion: '2025-06-18',
          discoveredAt: new Date().toISOString()
        }
      }
    })
    mcpRefreshTools.mockResolvedValue({ ok: true, serverName: 'test-server', tools: [discoveredTool] })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(mcpTestConnection).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('hello')).toBeTruthy()
    expect(screen.getByText(/mcp_new_hello_/)).toBeTruthy()
  })

  it('persists config and status after a successful test', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    mcpRefreshTools.mockResolvedValue({ ok: true, serverName: 'test-server', tools: [] })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalledTimes(1))
    expect(mcpRefreshTools).toHaveBeenCalledWith({ serverId: 'server-1' })
  })

  it('keeps enabled state when toggling right after a successful first test', async () => {
    // 模拟真实后端：mcpList 返回最近一次保存的 profiles 与工具缓存
    let savedProfiles: McpServerProfile[] = []
    let savedTools: unknown[] = []
    mcpList.mockImplementation(async () => ({
      servers: savedProfiles,
      toolCaches:
        savedProfiles.length > 0
          ? {
              [savedProfiles[0]!.id]: {
                tools: savedTools,
                protocolVersion: '2025-06-18',
                discoveredAt: new Date().toISOString()
              }
            }
          : {}
    }))
    mcpSaveProfiles.mockImplementation(async (payload: { servers: Array<McpServerProfile & { id: string }> }) => {
      savedProfiles = payload.servers.map((s) => ({
        ...SAVED_SERVER,
        ...s,
        auth: { mode: 'none', secretPresent: false },
        stdio: { command: 'node', args: ['server.js'], env: [] }
      }))
      return { servers: savedProfiles }
    })
    mcpRefreshTools.mockImplementation(async () => {
      savedTools = [
        {
          serverId: savedProfiles[0]?.id ?? 'server-1',
          originalName: 'hello',
          mappedName: 'mcp_new_hello_12345678',
          description: 'says hello',
          inputSchema: {},
          discoveredAt: new Date().toISOString()
        }
      ]
      return { ok: true, serverName: 'test-server', tools: savedTools }
    })

    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    const nameInput = (await screen.findByPlaceholderText('例如 GitHub')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'GitHub' } })

    // 首次测试成功（自动保存 + 刷新）
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(mcpRefreshTools).toHaveBeenCalled())

    // 立即启用并保存
    const toggle = await screen.findByRole('switch', { name: '启用此服务' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalledTimes(2))
    const payload = mcpSaveProfiles.mock.calls[1]![0] as { servers: Array<{ enabled: boolean }> }
    expect(payload.servers[0]!.enabled).toBe(true)

    // 回到列表后开关应为启用状态
    const cardToggle = await screen.findByRole('switch', { name: '启用此服务' })
    expect(cardToggle.getAttribute('aria-checked')).toBe('true')
  })

  it('preserves the enable toggle clicked while the test is still in flight', async () => {
    // 已保存服务 + 已有工具缓存：编辑弹窗中「启用服务」开关可用
    const cachedTool = {
      serverId: 'server-1',
      originalName: 'hello',
      mappedName: 'mcp_new_hello_12345678',
      description: 'says hello',
      inputSchema: {},
      discoveredAt: new Date().toISOString()
    }
    let profiles: McpServerProfile[] = [SAVED_SERVER]
    mcpList.mockImplementation(async () => ({
      servers: profiles,
      toolCaches: {
        'server-1': {
          tools: [cachedTool],
          protocolVersion: '2025-06-18',
          discoveredAt: new Date().toISOString()
        }
      }
    }))
    mcpSaveProfiles.mockImplementation(async (payload: { servers: Array<Partial<McpServerProfile> & { id: string }> }) => {
      profiles = payload.servers.map((s) => ({ ...SAVED_SERVER, ...s }) as McpServerProfile)
      return { servers: profiles }
    })
    // refresh-tools 挂起，模拟真实环境下测试链路耗时
    let resolveRefresh: (value: { ok: true; serverName: string; tools: unknown[] }) => void = () => undefined
    mcpRefreshTools.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )

    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }))
    // 测试链路尚未完成时就点击启用
    const toggle = await screen.findByRole('switch', { name: '启用此服务' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    resolveRefresh({ ok: true, serverName: 'test-server', tools: [cachedTool] })

    // 回刷完成后开关不应被重置为关闭
    await waitFor(() => expect(mcpRefreshTools).toHaveBeenCalled())
    const toggleAfter = await screen.findByRole('switch', { name: '启用此服务' })
    expect(toggleAfter.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalledTimes(2))
    const payload = mcpSaveProfiles.mock.calls[1]![0] as { servers: Array<{ enabled: boolean }> }
    expect(payload.servers[0]!.enabled).toBe(true)
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

  it('supports legacy SSE endpoint and bearer auth without OAuth', async () => {
    mcpList.mockResolvedValue({ servers: [], toolCaches: {} })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '添加服务' }))

    fireEvent.click(await screen.findByRole('tab', { name: 'SSE' }))
    expect(await screen.findByText('MCP Endpoint')).toBeTruthy()
    expect(await screen.findByText('认证方式')).toBeTruthy()
    expect(screen.queryByText('OAuth 2.1 (P0-C)')).toBeNull()
  })

  it('shows the legacy SSE label for saved SSE servers', async () => {
    mcpList.mockResolvedValue({ servers: [SSE_SERVER], toolCaches: {} })
    renderTab()
    expect(await screen.findByText('SSE')).toBeTruthy()
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

    expect(await screen.findByText(/60 秒/)).toBeTruthy()
    expect(screen.queryByText('调用超时（秒）')).toBeNull()

    fireEvent.click(screen.getByText('公共参数'))
    expect(await screen.findByText('调用超时（秒）')).toBeTruthy()
  })

  it('places the add-argument button on the args label row', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const addButtons = await screen.findAllByRole('button', { name: '添加' })
    expect(addButtons.some((b) => b.closest('.mcp-server-field__label-action'))).toBe(true)
  })

  it('places the add-environment button on the env label row', async () => {
    mcpList.mockResolvedValue({
      servers: [ENV_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const addButtons = await screen.findAllByRole('button', { name: '添加' })
    expect(addButtons).toHaveLength(2)
    const addButton = addButtons[1]!
    expect(addButton.closest('.mcp-server-field__label-action')).toBeTruthy()
  })

  it('shows dashed add placeholders when args and env lists are empty', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '添加服务' }))

    const addButtons = await screen.findAllByRole('button', { name: '添加' })
    expect(addButtons).toHaveLength(2)
    const addArg = addButtons[0]!
    const addEnv = addButtons[1]!
    expect(addArg.className).toContain('ant-btn-dashed')
    expect(addEnv.className).toContain('ant-btn-dashed')

    fireEvent.click(addArg)
    expect(document.querySelectorAll('.mcp-server-list-row').length).toBe(1)
  })

  it('deletes an environment row and marks its stored secret for clearing', async () => {
    mcpList.mockResolvedValue({
      servers: [ENV_SERVER],
      toolCaches: {}
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))

    const modal = await screen.findByRole('dialog')
    const deleteButtons = within(modal).getAllByRole('button', { name: '删除' })
    // [args 行删除, env 行删除]
    fireEvent.click(deleteButtons[1]!)
    expect(within(modal).queryByDisplayValue('GITHUB_TOKEN')).toBeNull()

    fireEvent.click(within(modal).getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalled())
    const payload = mcpSaveProfiles.mock.calls[0]![0] as { servers: Array<{ clearSecretKinds?: string[] }> }
    expect(payload.servers[0]!.clearSecretKinds).toContain('env:GITHUB_TOKEN')
  })

  it('auto-enables discovered tools when the server is turned on', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {
        'server-1': {
          tools: [
            {
              serverId: 'server-1',
              originalName: 'hello',
              mappedName: 'mcp_new_hello_12345678',
              description: 'says hello',
              inputSchema: {},
              discoveredAt: new Date().toISOString()
            }
          ],
          protocolVersion: '2025-06-18',
          discoveredAt: new Date().toISOString()
        }
      }
    })
    renderTab()
    const toggle = await screen.findByRole('switch', { name: '启用此服务' })
    expect(toggle.getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(toggle)

    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalled())
    const payload = mcpSaveProfiles.mock.calls[0]![0] as {
      servers: Array<{ enabled: boolean; enabledToolNames: string[] }>
    }
    expect(payload.servers[0]!.enabled).toBe(true)
    expect(payload.servers[0]!.enabledToolNames).toContain('hello')
  })

  it('tests an unsaved server draft from the card with draft credentials', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '添加服务' }))
    // 编辑弹窗中填写名称与 Bearer token 后关闭编辑（不保存）
    const nameInput = (await screen.findByPlaceholderText('例如 GitHub')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'GitHub' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))

    fireEvent.click(await screen.findByRole('button', { name: '测试并刷新' }))
    await waitFor(() => expect(mcpTestConnection).toHaveBeenCalled())
    // 测试成功后会自动保存配置并刷新，持久化工具缓存与连接状态
    await waitFor(() => expect(mcpSaveProfiles).toHaveBeenCalled())
    expect(mcpRefreshTools).toHaveBeenCalled()
  })

  it('refreshes a saved server from the card via refresh-tools', async () => {
    mcpList.mockResolvedValue({
      servers: [SAVED_SERVER],
      toolCaches: {}
    })
    mcpRefreshTools.mockResolvedValue({ ok: true, serverName: 'p', tools: [] })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '测试并刷新' }))
    await waitFor(() => expect(mcpRefreshTools).toHaveBeenCalled())
    expect(mcpTestConnection).not.toHaveBeenCalled()
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
