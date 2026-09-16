import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import type { Session } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE } from '../../../shared/domainTypes'
import { store } from '../../store'
import { setSessions } from '../../store/sessionSlice'
import { SessionListPane } from './SessionListPane'

vi.mock('../../services/chatRunnerService', () => ({
  abortSessionRun: vi.fn()
}))

vi.mock('../../hooks/usePendingConfirmSnapshot', () => ({
  usePendingConfirmSnapshot: () => []
}))

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    name: '会话',
    preview: '',
    model: 'claude',
    temperature: 0.7,
    maxTokens: 4096,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    skillsState: { ...DEFAULT_SESSION_SKILLS_STATE },
    metadata: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...overrides
  }
}

function renderPane(sessions: Session[]) {
  store.dispatch(setSessions(sessions))
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

describe('SessionListPane 偏差 7 分组渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.dispatch(setSessions([]))
  })

  it('automation+section 会话渲染在「管家」分区，主列表分组不混入', () => {
    renderPane([
      session({ id: 's-user', name: '日常会话' }),
      session({ id: 's-butler', name: '定时巡检', ownership: 'automation', visibility: 'section' })
    ])
    const butlerSection = screen.getByText('管家').closest('.session-group')
    expect(butlerSection).toBeTruthy()
    expect(within(butlerSection as HTMLElement).getByText('定时巡检')).toBeTruthy()
    const todayGroups = screen
      .getAllByText('今天')
      .map((el) => el.closest('.session-group'))
      .filter(Boolean) as HTMLElement[]
    expect(todayGroups.length).toBeGreaterThan(0)
    for (const group of todayGroups) {
      expect(within(group).queryByText('定时巡检')).toBeNull()
      expect(within(group).getByText('日常会话')).toBeTruthy()
    }
  })

  it('user 会话不出现在管家分区', () => {
    renderPane([session({ id: 's-only', name: '普通会话' })])
    expect(screen.queryByText('管家')).toBeNull()
    expect(screen.getByText('普通会话')).toBeTruthy()
  })
})
