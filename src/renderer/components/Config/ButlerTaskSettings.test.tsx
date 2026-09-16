import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { ButlerTaskSettings } from './ButlerTaskSettings'
import type { AutomationTask } from '../../../shared/automationTaskTypes'
import { changeAppLocale } from '../../i18n/localeSync'

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: 'task-1',
    name: '每日巡检',
    schedule: { kind: 'interval', intervalMinutes: 30 },
    prompt: '检查磁盘',
    deliveryPref: 'desktop',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('ButlerTaskSettings（P6 定时任务 Tab）', () => {
  const butlerListTasks = vi.fn()
  const butlerCreateTask = vi.fn()
  const butlerUpdateTask = vi.fn()
  const butlerDeleteTask = vi.fn()
  const butlerRunTask = vi.fn()
  const appGetTrayEnabled = vi.fn()

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    vi.clearAllMocks()
    appGetTrayEnabled.mockResolvedValue(true)
    butlerListTasks.mockResolvedValue([])
    butlerCreateTask.mockResolvedValue({ ok: true, id: 'new-1' })
    butlerUpdateTask.mockResolvedValue({ ok: true })
    butlerDeleteTask.mockResolvedValue({ ok: true })
    butlerRunTask.mockResolvedValue({ ok: true, runId: 'r1', summary: '完成' })
    window.api = {
      ...window.api,
      butlerListTasks,
      butlerCreateTask,
      butlerUpdateTask,
      butlerDeleteTask,
      butlerRunTask,
      appGetTrayEnabled
    } as typeof window.api
  })

  afterEach(() => {
    cleanup()
  })

  function renderTab() {
    return render(
      <ConfigProvider>
        <App>
          <ButlerTaskSettings />
        </App>
      </ConfigProvider>
    )
  }

  it('加载并渲染任务列表（名称、触发方式、投递偏好）', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    expect(screen.getByText('每 30 分钟')).toBeTruthy()
    expect(screen.getByText('桌面通知')).toBeTruthy()
  })

  it('托盘未启用时显示前提提示（P0 决策 a 的 UI 面）', async () => {
    appGetTrayEnabled.mockResolvedValue(false)
    renderTab()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('新建任务：提交后调用 butlerCreateTask 并刷新列表', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await waitFor(() => expect(screen.getByLabelText('任务名称')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '周报汇总' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '汇总本周会话' } })
    fireEvent.click(await screen.findByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    const payload = butlerCreateTask.mock.calls[0]![0] as { name: string; prompt: string; schedule: unknown }
    expect(payload.name).toBe('周报汇总')
    expect(payload.prompt).toBe('汇总本周会话')
    expect(payload.schedule).toEqual({ kind: 'interval', intervalMinutes: 30 })
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
  })

  it('启停开关：切换调用 butlerUpdateTask', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledTimes(1))
    expect(butlerUpdateTask.mock.calls[0]![0]).toMatchObject({ id: 'task-1', patch: { enabled: false } })
  })

  it('删除任务：确认后调用 butlerDeleteTask', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /删除任务/ }))
    // antd Popconfirm 默认确认文案 OK（未包 locale provider）
    fireEvent.click(await screen.findByRole('button', { name: /^OK$/ }))
    await waitFor(() => expect(butlerDeleteTask).toHaveBeenCalledTimes(1))
    expect(butlerDeleteTask.mock.calls[0]![0]).toEqual({ id: 'task-1' })
  })

  it('立即运行：调用 butlerRunTask 并展示结果摘要', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /立即运行/ }))
    await waitFor(() => expect(butlerRunTask).toHaveBeenCalledTimes(1))
    expect(butlerRunTask.mock.calls[0]![0]).toEqual({ taskId: 'task-1' })
    await waitFor(() => expect(screen.getByText(/完成/)).toBeTruthy())
  })

  it('列表渲染一次性任务的触发时刻标签', async () => {
      butlerListTasks.mockResolvedValue([
        task({ id: 'task-once', name: '周报汇总', schedule: { kind: 'once', at: new Date('2026-10-20T09:30:00').getTime() } })
      ])
      renderTab()
      await waitFor(() => expect(screen.getByText('周报汇总')).toBeTruthy())
      expect(screen.getByText(/一次性 2026-10-20 09:30/)).toBeTruthy()
    })
  
    it('编辑一次性任务回填执行时间并展示提示', async () => {
      butlerListTasks.mockResolvedValue([
        task({ id: 'task-once', name: '周报汇总', schedule: { kind: 'once', at: new Date('2026-10-20T09:30:00').getTime() } })
      ])
      renderTab()
      await waitFor(() => expect(screen.getByText('周报汇总')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
      await waitFor(() => expect(screen.getByText('到点执行一次，之后自动停用，不再重复执行')).toBeTruthy())
    })
})
