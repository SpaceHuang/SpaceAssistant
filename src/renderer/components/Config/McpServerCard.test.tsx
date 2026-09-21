import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import type { McpServerProfile, McpToolDescriptor } from '../../../shared/mcpTypes'
import type { McpServerDraft } from './mcpDrafts'
import { McpServerCard } from './McpServerCard'

const PROFILE: McpServerProfile = {
  id: 'server-1',
  name: 'scys-mcp',
  enabled: true,
  transport: 'streamable-http',
  timeoutSec: 60,
  auth: { mode: 'oauth', secretPresent: true },
  http: { endpoint: 'https://example.com/mcp' },
  enabledToolNames: [],
  status: 'connected',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z'
}

const DRAFT: McpServerDraft = {
  id: 'server-1',
  name: 'scys-mcp',
  enabled: true,
  transport: 'streamable-http',
  timeoutSec: 60,
  auth: { mode: 'oauth' },
  http: { endpoint: 'https://example.com/mcp' },
  enabledToolNames: []
}

function makeTool(name: string): McpToolDescriptor {
  return {
    serverId: 'server-1',
    originalName: name,
    mappedName: `mcp_scys_${name}_12345678`,
    description: '',
    inputSchema: { type: 'object' },
    discoveredAt: new Date().toISOString()
  }
}

function renderCard(props: Partial<Parameters<typeof McpServerCard>[0]> = {}) {
  return render(
    <ConfigProvider>
      <App>
        <McpServerCard
          draft={DRAFT}
          profile={PROFILE}
          tools={[makeTool('search'), makeTool('read')]}
          refreshing={false}
          dirty={false}
          canEnable
          onEdit={vi.fn()}
          onRefresh={vi.fn()}
          onDelete={vi.fn()}
          onClearSecret={vi.fn()}
          onOpenDiagnostics={vi.fn()}
          onOauthStart={vi.fn()}
          onToggleEnabled={vi.fn()}
          {...props}
        />
      </App>
    </ConfigProvider>
  )
}

describe('McpServerCard 未启用工具警示', () => {
  afterEach(() => {
    cleanup()
  })

  it('enabled + 已发现工具 + 白名单为空 → 显示「尚未启用」警示', () => {
    renderCard()
    const warning = screen.getByText(/尚未启用任何一个/)
    expect(warning).toBeTruthy()
    expect(warning.textContent).toContain('2')
  })

  it('白名单已有工具 → 不显示警示', () => {
    renderCard({ draft: { ...DRAFT, enabledToolNames: ['search'] } })
    expect(screen.queryByText(/尚未启用任何一个/)).toBeNull()
  })

  it('服务未启用 → 不显示警示', () => {
    renderCard({
      draft: { ...DRAFT, enabled: false },
      profile: { ...PROFILE, enabled: false }
    })
    expect(screen.queryByText(/尚未启用任何一个/)).toBeNull()
  })

  it('无已发现工具 → 不显示警示', () => {
    renderCard({ tools: [] })
    expect(screen.queryByText(/尚未启用任何一个/)).toBeNull()
  })
})
