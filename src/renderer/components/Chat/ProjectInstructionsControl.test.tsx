import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import { ProjectInstructionsControl } from './ProjectInstructionsControl'
import { store } from '../../store'
import { setSession } from '../../store/chatSlice'
import { setSessions } from '../../store/sessionSlice'
import type { Session } from '../../../shared/domainTypes'

const session: Session = {
  id: 'agents-session', name: 'Project', model: 'claude-test', temperature: 0.7, maxTokens: 1000,
  createdAt: 1, updatedAt: 1, skillsState: { manualActivated: [], manualDisabled: [] }, metadata: {}
}

describe('ProjectInstructionsControl', () => {
  beforeEach(() => {
    store.dispatch(setSession(session.id))
    store.dispatch(setSessions([session]))
    Object.assign(window.api, {
      chatGetAgentsMdRequestSnapshots: vi.fn().mockResolvedValue({ entries: [], current: { status: 'missing' } }),
      chatGetAgentsMdRequestSnapshot: vi.fn(),
      sessionUpdate: vi.fn().mockResolvedValue({ ...session, metadata: { agentsMdEnabled: false } })
    })
  })

  it('defaults to enabled, persists only the current session toggle, and loads scoped snapshots on open', async () => {
    render(<Provider store={store}><ConfigProvider><App><ProjectInstructionsControl /></App></ConfigProvider></Provider>)
    fireEvent.click(screen.getByRole('button', { name: '工作目录指令' }))
    expect(await screen.findByText(/当前文件：/)).toBeTruthy()
    expect(window.api.chatGetAgentsMdRequestSnapshots).toHaveBeenCalledWith({ sessionId: session.id, limit: 50 })
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(window.api.sessionUpdate).toHaveBeenCalledWith({ sessionId: session.id, agentsMdEnabled: false }))
  })

  it('displays request history without conflating an unavailable body with current disk state', async () => {
    vi.mocked(window.api.chatGetAgentsMdRequestSnapshots).mockResolvedValue({
      current: { status: 'loaded', digest: 'new-version' },
      entries: [{ invocationId: 'inv', requestId: 'req', modelTurn: 1, attempt: 1, status: 'loaded', digest: 'old-version', byteLength: 10, tokenCount: 3, loadedAt: 1, source: 'AGENTS.md', scope: 'workdir-root', bodyAvailable: false }]
    })
    render(<Provider store={store}><ConfigProvider><App><ProjectInstructionsControl /></App></ConfigProvider></Provider>)
    fireEvent.click(screen.getByRole('button', { name: '工作目录指令' }))
    expect(await screen.findByText(/将在下次模型请求时采用/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /R1/ }))
    expect(await screen.findByText('此快照正文不可还原。')).toBeTruthy()
    expect(screen.queryByText('new-version')).toBeNull()
  })
})
