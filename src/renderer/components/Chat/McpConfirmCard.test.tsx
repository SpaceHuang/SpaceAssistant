import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { McpConfirmCard } from './McpConfirmCard'

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 't1',
    toolName: 'mcp_github_create_issue_12345678',
    input: { title: 'bug', apiKey: 'sk-secret' },
    status: 'confirming',
    riskLevel: 'medium',
    mcp: {
      serverId: 'server-1',
      serverName: 'GitHub',
      originalToolName: 'create_issue',
      description: 'creates an issue'
    },
    ...overrides
  }
}

describe('McpConfirmCard', () => {
  afterEach(() => {
    cleanup()
  })

  function renderCard(record: ToolCallRecord, onConfirm = vi.fn()) {
    render(
      <ConfigProvider>
        <App>
          <McpConfirmCard record={record} onConfirm={onConfirm} sessionId="session-1" />
        </App>
      </ConfigProvider>
    )
    return onConfirm
  }

  it('shows server, original tool and description', () => {
    renderCard(makeRecord())
    expect(screen.getByText('外部 MCP 工具调用')).toBeTruthy()
    expect(screen.getByText('服务：GitHub')).toBeTruthy()
    expect(screen.getByText('原始工具：create_issue')).toBeTruthy()
    expect(screen.getByText('creates an issue')).toBeTruthy()
  })

  it('denies without trust when deny clicked', () => {
    const onConfirm = renderCard(makeRecord())
    fireEvent.click(screen.getByText('拒绝'))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('approves with session trust when checked', () => {
    const onConfirm = renderCard(makeRecord())
    fireEvent.click(screen.getByText('本会话信任'))
    fireEvent.click(screen.getByText('允许'))
    expect(onConfirm).toHaveBeenCalledWith(true, {
      sessionId: 'session-1',
      trustMcpServerId: 'server-1',
      trustMcpToolName: 'create_issue'
    })
  })

  it('approves without trust options when unchecked', () => {
    const onConfirm = renderCard(makeRecord())
    fireEvent.click(screen.getByText('允许'))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('renders nothing when mcp metadata is missing', () => {
    render(
      <ConfigProvider>
        <App>
          <McpConfirmCard record={makeRecord({ mcp: undefined })} onConfirm={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    expect(screen.queryByText('外部 MCP 工具调用')).toBeNull()
  })
})
