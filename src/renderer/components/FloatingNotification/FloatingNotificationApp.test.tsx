import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FloatingNotificationApp } from './FloatingNotificationApp'

function createMockApi() {
  return {
    notificationGetData: vi.fn().mockResolvedValue({
      totalSessions: 0,
      totalItems: 0,
      latestItem: null
    }),
    notificationReady: vi.fn().mockResolvedValue(undefined),
    notificationFocusSession: vi.fn().mockResolvedValue(undefined),
    notificationShowMain: vi.fn().mockResolvedValue(undefined),
    notificationDismiss: vi.fn().mockResolvedValue(undefined),
    notificationOnUpdate: vi.fn(() => vi.fn()),
    notificationOnClose: vi.fn(() => vi.fn())
  }
}

describe('FloatingNotificationApp', () => {
  let mockApi: ReturnType<typeof createMockApi>

  beforeEach(() => {
    mockApi = createMockApi();
    (window as any).api = mockApi
  })

  it('should render title bar with close button', async () => {
    render(<FloatingNotificationApp />)

    await waitFor(() => {
      expect(screen.getByText('待确认操作')).toBeTruthy()
      expect(screen.getByLabelText('关闭通知')).toBeTruthy()
    })
  })

  it('should render footer summary with zero items', async () => {
    render(<FloatingNotificationApp />)

    await waitFor(() => {
      expect(screen.getByText(/共 0 个会话 · 0 项待确认/)).toBeTruthy()
    })
  })

  it('should render latest item when data is provided', async () => {
    mockApi.notificationGetData.mockResolvedValue({
      totalSessions: 2,
      totalItems: 3,
      latestItem: {
        sessionId: 's1',
        sessionName: '测试会话',
        toolUseId: 't1',
        toolName: 'run_shell',
        toolLabel: 'run_shell — npm install',
        createdAt: Date.now()
      }
    })

    render(<FloatingNotificationApp />)

    await waitFor(() => {
      expect(screen.getByText('测试会话')).toBeTruthy()
      expect(screen.getByText('run_shell — npm install')).toBeTruthy()
      expect(screen.getByText(/共 2 个会话 · 3 项待确认/)).toBeTruthy()
    })
  })

  it('should call notificationFocusSession when body is clicked', async () => {
    mockApi.notificationGetData.mockResolvedValue({
      totalSessions: 1,
      totalItems: 1,
      latestItem: {
        sessionId: 's1',
        sessionName: '测试',
        toolUseId: 't1',
        toolName: 'run_shell',
        toolLabel: 'run_shell — cmd',
        createdAt: Date.now()
      }
    })

    render(<FloatingNotificationApp />)

    await waitFor(() => {
      expect(screen.getByText('测试')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /回到主界面确认/ }))
    expect(mockApi.notificationFocusSession).toHaveBeenCalledWith({
      sessionId: 's1',
      toolUseId: 't1'
    })
  })

  it('should call notificationShowMain when back button is clicked', async () => {
    render(<FloatingNotificationApp />)

    await waitFor(() => {
      expect(screen.getByText('回到主界面')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('回到主界面'))
    expect(mockApi.notificationShowMain).toHaveBeenCalled()
  })

  it('should call notificationDismiss when close button is clicked', async () => {
    render(<FloatingNotificationApp />)

    await waitFor(() => {
      expect(screen.getByLabelText('关闭通知')).toBeTruthy()
    })

    fireEvent.click(screen.getByLabelText('关闭通知'))
    expect(mockApi.notificationDismiss).toHaveBeenCalled()
  })

  it('should subscribe to update and close events on mount', async () => {
    render(<FloatingNotificationApp />)

    await waitFor(() => {
      expect(mockApi.notificationOnUpdate).toHaveBeenCalled()
      expect(mockApi.notificationOnClose).toHaveBeenCalled()
      expect(mockApi.notificationReady).toHaveBeenCalled()
    })
  })
})
