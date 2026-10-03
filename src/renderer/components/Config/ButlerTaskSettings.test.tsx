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
  const butlerGetTaskDefaults = vi.fn()
  const butlerGetModelCandidates = vi.fn()
  const butlerChooseWorkDir = vi.fn()
  const butlerListTaskRuns = vi.fn()
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
    butlerGetTaskDefaults.mockResolvedValue({ workDir: '/tmp/seed', modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'model-name', reasoningEffort: 'medium' })
    butlerGetModelCandidates.mockResolvedValue([{ modelId: 'model-1', providerModelName: 'model-name', serviceId: 'service-1', serviceName: 'Service', supportsThinking: true }])
    butlerChooseWorkDir.mockResolvedValue({ cancelled: false, path: '/tmp/chosen' })
    butlerListTaskRuns.mockResolvedValue([])
    window.api = {
      ...window.api,
      butlerListTasks,
      butlerCreateTask,
      butlerUpdateTask,
      butlerDeleteTask,
      butlerRunTask,
      butlerGetTaskDefaults,
      butlerGetModelCandidates,
      butlerChooseWorkDir,
      butlerListTaskRuns,
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
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await waitFor(() => expect(screen.getByLabelText('任务名称')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '周报汇总' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '汇总本周会话' } })
    fireEvent.click(await screen.findByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    const payload = butlerCreateTask.mock.calls[0]![0] as { name: string; prompt: string; schedule: unknown }
    expect(payload.name).toBe('周报汇总')
    expect(payload.prompt).toBe('汇总本周会话')
    expect(payload.schedule).toEqual({ kind: 'interval', intervalMinutes: 30 })
    expect(payload).toMatchObject({ workDir: '/tmp/seed', modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'model-name', reasoningEffort: 'medium' })
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
  })

  it('默认模型不支持 Thinking 时以 off 创建任务', async () => {
    butlerGetTaskDefaults.mockResolvedValueOnce({ workDir: '/tmp/seed', modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'model-name', reasoningEffort: 'high' })
    butlerGetModelCandidates.mockResolvedValueOnce([{ modelId: 'model-1', providerModelName: 'model-name', serviceId: 'service-1', serviceName: 'Service', supportsThinking: false }])
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '无 Thinking 模型任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '执行检查' } })
    fireEvent.click(await screen.findByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'off' })
  })

  it('旧任务编辑显示未设置目录，加载时不触发保存或自动填值', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    expect(await screen.findByText('旧任务会继续使用兼容配置；如需固定独立目录或模型，可在此选择后保存')).toBeTruthy()
    expect(butlerUpdateTask).not.toHaveBeenCalled()
  })

  it('旧任务可以只编辑名称、提示词和排程并保留兼容配置', async () => {
    butlerListTasks.mockResolvedValue([task({ modelOverride: 'legacy-provider-model' })])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '改名后的任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '改后的提示词' } })
    fireEvent.click(await screen.findByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledTimes(1))
    const payload = butlerUpdateTask.mock.calls[0]![0] as { patch: Record<string, unknown> }
    expect(payload.patch).toMatchObject({ name: '改名后的任务', prompt: '改后的提示词' })
    expect(payload.patch).not.toHaveProperty('workDir')
    expect(payload.patch).not.toHaveProperty('modelId')
    expect(payload.patch).not.toHaveProperty('modelServiceId')
    expect(payload.patch).not.toHaveProperty('reasoningEffort')
  })

  it('目录选择器提交明确路径，用户取消不写入表单', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    const browse = await screen.findByRole('button', { name: '浏览目录' })
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: true })
    fireEvent.click(browse)
    expect(await screen.findByDisplayValue('/tmp/seed')).toBeTruthy()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/chosen' })
    fireEvent.click(browse)
    expect(await screen.findByDisplayValue('/tmp/chosen')).toBeTruthy()
  })

  it('历史详情读取 run 快照而不采用任务当前配置', async () => {
    butlerListTasks.mockResolvedValue([task({ workDir: '/new/task/path' })])
    butlerListTaskRuns.mockResolvedValue([{ id: 'run-1', taskId: 'task-1', clientId: 'c', trigger: 'manual', scheduledFor: 1, status: 'completed', deliveryStatus: 'none', createdAt: 1, updatedAt: 1, configSnapshot: { resolutionStatus: 'resolved', workDir: '/old/run/path', modelId: 'm1', providerModelName: 'provider-name', serviceId: 'svc-1', routeIdentity: 'route-1', requestedEffort: 'high', effectiveEffort: 'off', reasoningDegraded: true } }])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '运行历史' }))
    expect(await screen.findByText('/old/run/path')).toBeTruthy()
    expect(screen.getByText('provider-name · svc-1 · high → off')).toBeTruthy()
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

  it('列表用卡片行结构渲染（butler-task-card，对齐设置页卡片语言）', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    const card = document.querySelector('.butler-task-card')
    expect(card).toBeTruthy()
    expect(card!.querySelector('.butler-task-card__title')?.textContent).toBe('每日巡检')
    expect(card!.querySelector('.butler-task-card__summary')?.textContent).toContain('检查磁盘')
    expect(card!.querySelectorAll('.butler-task-card__tag')).toHaveLength(2)
    expect(card!.querySelector('.butler-task-card__header .ant-switch')).toBeTruthy()
    expect(card!.querySelector('.butler-task-card__footer')).toBeTruthy()
  })

  it('停用任务带 disabled 视觉类；编辑图标按钮可打开编辑器', async () => {
    butlerListTasks.mockResolvedValue([task({ enabled: false })])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    expect(document.querySelector('.butler-task-card--disabled')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    await waitFor(() => expect(screen.getByText('编辑定时任务')).toBeTruthy())
  })

  it('daily 默认时间解析有效（customParseFormat 注册后非 Invalid Date）', async () => {
    // 回归评审 P1-2：未注册插件时 dayjs(值, 格式) 返回 Invalid Date，提交产出 'Invalid Date' 被主进程拒绝
    const dayjs = (await import('dayjs')).default
    await import('./ButlerTaskSettings')
    const parsed = dayjs('09:00', 'HH:mm')
    expect(parsed.isValid()).toBe(true)
    expect(parsed.format('HH:mm')).toBe('09:00')
  })

  it('主进程返回 ok:false 时不提示成功、弹窗不关闭、不刷新列表（假成功防护）', async () => {
    butlerCreateTask.mockResolvedValue({ ok: false, error: '任务参数不完整（名称 / 提示词 / 触发方式 / 投递偏好）' })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await waitFor(() => expect(screen.getByLabelText('任务名称')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '会失败的任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: 'x' } })
    fireEvent.click(await screen.findByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    // 失败分支：不关弹窗、不刷新（成功分支会刷新 → 第 2 次 list 调用）
    expect(screen.getByText('新建定时任务')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(butlerListTasks).toHaveBeenCalledTimes(1)
  })
})
