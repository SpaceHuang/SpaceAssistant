import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import type { Session } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE } from '../../../shared/domainTypes'
import { store } from '../../store'
import { SessionTitleEditor } from './SessionTitleEditor'

const mockSessionUpdate = vi.fn()

function stubSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: '会话 1',
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

function renderEditor(session: Session, onDone = vi.fn()) {
  return render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <SessionTitleEditor session={session} onDone={onDone} />
        </App>
      </ConfigProvider>
    </Provider>
  )
}

describe('SessionTitleEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api = {
      ...window.api,
      sessionUpdate: mockSessionUpdate
    } as typeof window.api
  })

  it('confirms on Enter with a new name', async () => {
    const onDone = vi.fn()
    const updated = stubSession({ name: '新标题' })
    mockSessionUpdate.mockResolvedValue(updated)

    renderEditor(stubSession(), onDone)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mockSessionUpdate).toHaveBeenCalledWith({ sessionId: 'session-1', name: '新标题' })
    })
    await waitFor(() => {
      expect(store.getState().session.list.find((s) => s.id === 'session-1')?.name).toBe('新标题')
    })
    expect(onDone).toHaveBeenCalled()
  })

  it('cancels on Escape without calling sessionUpdate', () => {
    const onDone = vi.fn()
    renderEditor(stubSession(), onDone)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(mockSessionUpdate).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('does not call sessionUpdate for empty trimmed input', () => {
    const onDone = vi.fn()
    renderEditor(stubSession({ name: '会话 1' }), onDone)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockSessionUpdate).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('does not call sessionUpdate when name is unchanged', () => {
    const onDone = vi.fn()
    renderEditor(stubSession({ name: '会话 1' }), onDone)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '  会话 1  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockSessionUpdate).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('confirms on blur', async () => {
    const onDone = vi.fn()
    mockSessionUpdate.mockResolvedValue(stubSession({ name: 'blur 名' }))
    renderEditor(stubSession(), onDone)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'blur 名' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockSessionUpdate).toHaveBeenCalledWith({ sessionId: 'session-1', name: 'blur 名' })
    })
  })

  it('shows error toast when sessionUpdate fails', async () => {
    const onDone = vi.fn()
    mockSessionUpdate.mockRejectedValue(new Error('network'))
    renderEditor(stubSession(), onDone)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '失败名' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mockSessionUpdate).toHaveBeenCalled()
    })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('uses raw stored name as default value', () => {
    renderEditor(stubSession({ name: '' }), vi.fn())
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('')
  })
})
