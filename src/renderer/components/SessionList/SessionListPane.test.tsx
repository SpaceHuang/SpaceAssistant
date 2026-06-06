import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import type { Session } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'
import { store } from '../../store'
import { setSession } from '../../store/chatSlice'
import { setSessions } from '../../store/sessionSlice'
import { SessionListPane } from './SessionListPane'

vi.mock('../../services/chatRunnerService', () => ({
  abortSessionRun: vi.fn()
}))

vi.mock('./PendingConfirmBanner', () => ({
  PendingConfirmBanner: () => null
}))

const mockSessionUpdate = vi.fn()
const mockSessionDelete = vi.fn()

function stubSession(id: string, name: string): Session {
  return {
    id,
    name,
    preview: '',
    model: 'claude',
    temperature: 0.7,
    maxTokens: 4096,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    skillsState: { ...DEFAULT_SESSION_SKILLS_STATE },
    metadata: {},
    schemaVersion: CURRENT_SCHEMA_VERSION
  }
}

function renderPane(sessions: Session[], currentSessionId: string | null = null) {
  store.dispatch(setSessions(sessions))
  store.dispatch(setSession(currentSessionId))
  return render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <SessionListPane />
        </App>
      </ConfigProvider>
    </Provider>
  )
}

describe('SessionListPane rename', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    store.dispatch(setSessions([]))
    store.dispatch(setSession(null))
    await changeAppLocale('zh-CN')
    window.api = {
      ...window.api,
      sessionUpdate: mockSessionUpdate,
      sessionDelete: mockSessionDelete.mockResolvedValue(undefined)
    } as typeof window.api
  })

  it('opens rename editor from context menu', async () => {
    renderPane([stubSession('s1', '会话 A')])
    fireEvent.contextMenu(screen.getByText('会话 A'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))
    expect(screen.getByLabelText('编辑会话标题')).toBeDefined()
  })

  it('does not switch session when clicking row during edit', async () => {
    renderPane([stubSession('s1', '会话 A'), stubSession('s2', '会话 B')], 's2')
    fireEvent.contextMenu(screen.getByText('会话 A'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))

    const selectBtn = screen.getByLabelText('编辑会话标题').closest('button')!
    fireEvent.click(selectBtn)

    expect(store.getState().chat.currentSessionId).toBe('s2')
  })

  it('keeps only the latest session in edit mode', async () => {
    renderPane([stubSession('s1', '会话 A'), stubSession('s2', '会话 B')])
    fireEvent.contextMenu(screen.getByText('会话 A'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))
    expect(screen.getAllByLabelText('编辑会话标题')).toHaveLength(1)

    fireEvent.contextMenu(screen.getByText('会话 B'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))
    expect(screen.getAllByLabelText('编辑会话标题')).toHaveLength(1)
    expect((screen.getByLabelText('编辑会话标题') as HTMLInputElement).value).toBe('会话 B')
  })

  it('updates list display after successful rename', async () => {
    mockSessionUpdate.mockResolvedValue(stubSession('s1', '重构登录'))
    renderPane([stubSession('s1', '会话 A')])
    fireEvent.contextMenu(screen.getByText('会话 A'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))

    const input = screen.getByLabelText('编辑会话标题')
    fireEvent.change(input, { target: { value: '重构登录' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByText('重构登录')).toBeDefined()
    })
  })

  it('filters renamed session by new name in search', async () => {
    mockSessionUpdate.mockResolvedValue(stubSession('s1', '重构登录'))
    renderPane([stubSession('s1', '会话 A'), stubSession('s2', '其它')])
    fireEvent.contextMenu(screen.getByText('会话 A'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const input = screen.getByLabelText('编辑会话标题')
    fireEvent.change(input, { target: { value: '重构登录' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByText('重构登录')).toBeDefined()
    })

    const search = screen.getByLabelText('搜索会话')
    fireEvent.change(search, { target: { value: '重构' } })
    expect(screen.getByText('重构登录')).toBeDefined()
    expect(screen.queryByText('其它')).toBeNull()
  })
})

describe('SessionItemContextMenu', () => {
  it('exposes rename menu item when open', async () => {
    await changeAppLocale('zh-CN')
    const { SessionItemContextMenu } = await import('./SessionItemContextMenu')
    render(
      <ConfigProvider>
        <SessionItemContextMenu onRename={vi.fn()} open>
          <span>trigger</span>
        </SessionItemContextMenu>
      </ConfigProvider>
    )
    expect(within(document.body).getByText('重命名')).toBeDefined()
  })
})
