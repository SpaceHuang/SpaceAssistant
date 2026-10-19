import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    authorizedDirs: [],
    workDirs: [],
    outputDir: null,
    outputOrganization: null,
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
  const butlerConfirmTaskAuthorization = vi.fn()
  const butlerDeleteTask = vi.fn()
  const butlerRunTask = vi.fn()
  const butlerGetTaskDefaults = vi.fn()
  const butlerGetModelCandidates = vi.fn()
  const butlerChooseWorkDir = vi.fn()
  const butlerChooseOutputDir = vi.fn()
  const butlerListTaskRuns = vi.fn()
  const appGetTrayEnabled = vi.fn()

  beforeEach(async () => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key?.startsWith('spaceassistant:butler-task-draft:v1:')) localStorage.removeItem(key)
    }
    await changeAppLocale('zh-CN')
    vi.clearAllMocks()
    appGetTrayEnabled.mockResolvedValue(true)
    butlerListTasks.mockResolvedValue([])
    butlerCreateTask.mockResolvedValue({ ok: true, id: 'new-1' })
    butlerUpdateTask.mockResolvedValue({ ok: true })
    butlerConfirmTaskAuthorization.mockResolvedValue({ ok: true, id: 'new-1' })
    butlerDeleteTask.mockResolvedValue({ ok: true })
    butlerRunTask.mockResolvedValue({ ok: true, runId: 'r1', summary: '完成' })
    butlerGetTaskDefaults.mockResolvedValue({ workDir: '/tmp/active-profile', modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'model-name', reasoningEffort: 'medium' })
    butlerGetModelCandidates.mockResolvedValue([{ modelId: 'model-1', providerModelName: 'model-name', serviceId: 'service-1', serviceName: 'Service', supportsThinking: true }])
    butlerChooseWorkDir.mockResolvedValue({ cancelled: false, path: '/tmp/chosen' })
    butlerChooseOutputDir.mockResolvedValue({ cancelled: false, path: '/tmp/output' })
    butlerListTaskRuns.mockResolvedValue([])
    window.api = {
      ...window.api,
      butlerListTasks,
      butlerCreateTask,
      butlerUpdateTask,
      butlerConfirmTaskAuthorization,
      butlerDeleteTask,
      butlerRunTask,
      butlerGetTaskDefaults,
      butlerGetModelCandidates,
      butlerChooseWorkDir,
      butlerChooseOutputDir,
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

  async function chooseOutputDir(path = '/tmp/output') {
    butlerChooseOutputDir.mockResolvedValueOnce({ cancelled: false, path })
    fireEvent.click(await screen.findByRole('button', { name: '选择结果输出目录' }))
    await waitFor(() => expect(screen.getByLabelText('结果输出目录')).toHaveProperty('value', path))
  }

  async function clickTaskSubmit() {
    fireEvent.click(await screen.findByRole('button', { name: /预检并查看权限|确认授权并保存任务/ }))
  }

  async function chooseSelectOption(label: string, option: string) {
    fireEvent.mouseDown(screen.getByRole('combobox', { name: label }))
    await waitFor(() => {
      const options = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option-content'))
      expect(options.some((item) => item.textContent?.trim() === option)).toBe(true)
    })
    const optionContent = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option-content'))
      .find((item) => item.textContent?.trim() === option)
    if (!optionContent) throw new Error(`找不到下拉选项：${option}`)
    fireEvent.click(optionContent)
  }

  function selectedArchiveValue() {
    return screen.getByRole('combobox', { name: '结果归档方式' }).closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent
  }

  function selectedTriggerValue() {
    return screen.getByRole('combobox', { name: '触发方式' }).closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent
  }

  it('加载并渲染任务列表（名称、触发方式、投递偏好）', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    expect(screen.getByText('每 30 分钟')).toBeTruthy()
    expect(screen.getByText('桌面通知')).toBeTruthy()
  })

  it('预检后关闭并重新打开新建表单时恢复草稿，但重新进行权限预检', async () => {
    const reviewResponse = {
      ok: false as const,
      kind: 'authorization-review-required' as const,
      reviewId: 'review-stale',
      report: { status: 'passed' as const, blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'directory-read-write' as const, path: '/tmp/materials' }]
    }
    butlerCreateTask.mockResolvedValueOnce(reviewResponse).mockResolvedValueOnce({
      ...reviewResponse,
      reviewId: 'review-fresh'
    })

    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '草稿巡检' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '读取资料并生成结果' } })
    await chooseSelectOption('触发方式', '每天')
    await chooseSelectOption('结果归档方式', '直接写入该目录')
    await chooseOutputDir('/tmp/draft-results')
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/materials' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await waitFor(() => expect(screen.getByText('/tmp/materials')).toBeTruthy())

    await clickTaskSubmit()
    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))

    cleanup()
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)

    expect(await screen.findByLabelText('任务名称')).toHaveProperty('value', '草稿巡检')
    expect(screen.getByLabelText('任务提示词')).toHaveProperty('value', '读取资料并生成结果')
    expect(screen.getByLabelText('结果输出目录')).toHaveProperty('value', '/tmp/draft-results')
    expect(selectedTriggerValue()).toBe('每天')
    expect(selectedArchiveValue()).toBe('直接写入该目录')
    expect(screen.getByText('/tmp/materials')).toBeTruthy()
    expect(screen.queryByText('请检查此定时任务需要的权限')).toBeNull()
    expect(screen.getByRole('button', { name: '预检并查看权限' })).toBeTruthy()

    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(2))
    expect(butlerCreateTask.mock.calls[1]![0]).toMatchObject({
      name: '草稿巡检',
      prompt: '读取资料并生成结果',
      schedule: { kind: 'daily', time: '09:00' },
      authorizedDirs: ['/tmp/materials'],
      outputDir: '/tmp/draft-results',
      outputOrganization: 'direct'
    })
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()
  })

  it('点击预检即暂存已填写内容，即使必填校验未通过', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '未完成草稿' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '整理工作资料' } })

    await clickTaskSubmit()
    expect(await screen.findByText('请选择结果输出目录')).toBeTruthy()
    expect(butlerCreateTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))

    cleanup()
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)

    expect(await screen.findByLabelText('任务名称')).toHaveProperty('value', '未完成草稿')
    expect(screen.getByLabelText('任务提示词')).toHaveProperty('value', '整理工作资料')
    expect(screen.getByLabelText('结果输出目录')).toHaveProperty('value', '')
  })

  it('编辑任务的预检草稿按任务 ID 恢复', async () => {
    const existing = task({ outputDir: '/tmp/task-results', outputOrganization: 'daily', authorizedDirs: ['/tmp/task-materials'], workDirs: ['/tmp/task-materials'] })
    butlerListTasks.mockResolvedValue([existing])
    butlerUpdateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'edit-review-stale',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'directory-read-write', path: '/tmp/task-materials' }]
    })

    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '编辑中的草稿' } })
    await clickTaskSubmit()
    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))

    cleanup()
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))

    expect(await screen.findByLabelText('任务名称')).toHaveProperty('value', '编辑中的草稿')
    expect(screen.getByLabelText('结果输出目录')).toHaveProperty('value', '/tmp/task-results')
    expect(selectedArchiveValue()).toBe('每次执行写入按日期（YYYYMMDD）创建的子目录')
    expect(screen.getByText('/tmp/task-materials')).toBeTruthy()
    expect(screen.queryByText('请检查此定时任务需要的权限')).toBeNull()
  })

  it('托盘未启用时显示前提提示（P0 决策 a 的 UI 面）', async () => {
    appGetTrayEnabled.mockResolvedValue(false)
    renderTab()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('按任务流程分组表单，并将模型与思维强度放在同一大模型服务区', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await screen.findByLabelText('任务名称')

    expect(screen.getAllByRole('region').map((region) => region.querySelector('h5')?.textContent)).toEqual([
      '任务内容',
      '大模型服务',
      '执行与投递',
      '结果输出',
      '资料与本机访问权限'
    ])

    const modelServiceSection = screen.getByRole('region', { name: '大模型服务' })
    expect(within(modelServiceSection).getByRole('combobox', { name: '任务模型与服务' })).toBeTruthy()
    expect(within(modelServiceSection).getByRole('combobox', { name: '思维强度' })).toBeTruthy()
  })

  it('新建任务：提交后调用 butlerCreateTask 并刷新列表', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false, kind: 'authorization-review-required', reviewId: 'review-1',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [
        { kind: 'directory-read-write', path: '/tmp/chosen-root' },
        { kind: 'result-write', outputDirectory: '/tmp/output-root', organization: 'hourly' },
        { kind: 'local-shell', scopeRoots: ['/tmp/chosen-root'], commands: [{ command: 'git log --oneline -5', workingDirectory: '/tmp/chosen-root' }] },
        { kind: 'grep', scopeRoots: ['/tmp/chosen-root/src'] },
        { kind: 'run-script', scopeRoots: ['/tmp/chosen-root'], scriptHashBinding: 'per-invocation' },
        { kind: 'mcp-tool', serverId: 'mcp-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues',
          purpose: '查找近期问题', parameters: [{ name: 'query', required: true }, { name: 'limit', required: false }], descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64) }
      ]
    })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await waitFor(() => expect(screen.getByLabelText('任务名称')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '周报汇总' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '汇总本周会话' } })
    await chooseOutputDir('/tmp/output-root')
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/chosen-root' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await waitFor(() => expect(screen.getByText('/tmp/chosen-root')).toBeTruthy())
    expect(screen.queryByRole('checkbox', { name: '允许本地 Shell 命令' })).toBeNull()
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    expect(screen.getByText('可运行列出的本机命令及完整参数（包括本地 Git 查询）；每条命令注明工作目录：git log --oneline -5（/tmp/chosen-root）。执行超时由 Agent 按实际情况选择，不属于授权范围。命令访问范围：/tmp/chosen-root。')).toBeTruthy()
    expect(screen.queryByText(/超时：30s/)).toBeNull()
    expect(screen.getByText('可在以下目录中使用 grep 搜索内容：/tmp/chosen-root/src。')).toBeTruthy()
    expect(screen.getByText('可在以下目录运行经安全审核的脚本：/tmp/chosen-root。每次审核绑定该脚本的 SHA-256，脚本内容变化后必须重新审核。')).toBeTruthy()
    expect(screen.getByText('可调用 MCP 服务「Issue Tracker」中的工具「search_issues」：Search issues。任务用途：查找近期问题。参数：query (必填)、limit。授权绑定当前服务配置与工具定义；安全审核 Agent 仍会检查每次调用的实际参数。')).toBeTruthy()
    const payload = butlerCreateTask.mock.calls[0]![0] as { name: string; prompt: string; schedule: unknown; authorizedDirs: string[]; outputDir: string; outputOrganization: string }
    expect(payload.name).toBe('周报汇总')
    expect(payload.prompt).toBe('汇总本周会话')
    expect(payload.schedule).toEqual({ kind: 'interval', intervalMinutes: 30 })
    expect(payload).toMatchObject({ authorizedDirs: ['/tmp/chosen-root'], outputDir: '/tmp/output-root', outputOrganization: 'hourly', modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'model-name', reasoningEffort: 'medium' })
    expect(payload).not.toHaveProperty('accessPermissions')
    await clickTaskSubmit()
    await waitFor(() => expect(butlerConfirmTaskAuthorization).toHaveBeenCalledWith({ reviewId: 'review-1' }))
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
  })

  it('新建任务必须先选择结果输出目录，授权读写目录可以留空', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '只输出任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '生成摘要' } })
    await clickTaskSubmit()

    expect(await screen.findByText('请选择结果输出目录')).toBeTruthy()
    expect(screen.queryByText('请选择任务工作目录')).toBeNull()
    expect(butlerCreateTask).not.toHaveBeenCalled()
  })

  it('归档方式默认跟随触发类型，用户手动更改后不再覆盖', async () => {
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await screen.findByLabelText('任务名称')

    await chooseSelectOption('触发方式', '每天')
    expect(selectedTriggerValue()).toBe('每天')
    expect(selectedArchiveValue()).toBe('每次执行写入按日期（YYYYMMDD）创建的子目录')

    await chooseSelectOption('触发方式', '一次性')
    expect(selectedArchiveValue()).toBe('直接写入该目录')

    await chooseSelectOption('结果归档方式', '每次执行写入按日期（YYYYMMDD）创建的子目录')
    await chooseSelectOption('触发方式', '固定间隔')
    expect(selectedArchiveValue()).toBe('每次执行写入按日期（YYYYMMDD）创建的子目录')
  })

  it('默认模型不支持 Thinking 时以 off 创建任务', async () => {
    butlerGetTaskDefaults.mockResolvedValueOnce({ modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'model-name', reasoningEffort: 'high' })
    butlerGetModelCandidates.mockResolvedValueOnce([{ modelId: 'model-1', providerModelName: 'model-name', serviceId: 'service-1', serviceName: 'Service', supportsThinking: false }])
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '无 Thinking 模型任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '执行检查' } })
    expect(await screen.findByText('当前模型不支持思维强度设置。')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '思维强度' }).closest('.ant-select')?.classList.contains('ant-select-disabled')).toBe(true)
    await chooseOutputDir()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/chosen-root' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'off' })
  })

  it('TARGET_UNCLEAR 时不保存任务，并在表单显示可理解的预检问题', async () => {
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_UNCLEAR', messageKey: 'butler.preflight.target_unclear', reference: '帮我处理一下', reasonCode: 'scope_unclear' }], suggestedDirectories: [] } })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '待补充目标' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '帮我处理一下' } })
    await chooseOutputDir()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/chosen-root' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await waitFor(() => expect(screen.getByText('/tmp/chosen-root')).toBeTruthy())
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('无法确定要处理的文件、目录或范围，请在任务提示词中补充具体目标。')).toBeTruthy()
    expect(screen.getByText('相关描述：帮我处理一下')).toBeTruthy()
    expect(screen.getByLabelText('任务提示词')).toBeTruthy()
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ name: '待补充目标' })
    expect(butlerListTasks).toHaveBeenCalledTimes(1)
  })

  it('Git 查询缺少授权仓库时说明要添加仓库目录', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: {
      status: 'blocked', blockers: [{ code: 'TARGET_NOT_FOUND', messageKey: 'butler.preflight.target_not_found', reference: prompt, reasonCode: 'git_repository_not_found' }], suggestedDirectories: []
    } })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: 'Git 提交汇总' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: prompt } })
    await chooseOutputDir()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/materials' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await clickTaskSubmit()

    expect(await screen.findByText('在已授权的读写目录中没有找到这个目标。请检查名称或把目标所在目录加入授权读写目录。')).toBeTruthy()
    expect(screen.getByText('已授权目录中没有发现 Git 仓库。请把目标仓库根目录加入授权读写目录，再重新预检。')).toBeTruthy()
    expect(screen.getByText(`相关描述：${prompt}`)).toBeTruthy()
    expect(screen.getByText('按上方说明补充任务提示词或调整授权读写目录列表，然后再次预检。')).toBeTruthy()
    expect(butlerCreateTask).toHaveBeenCalledTimes(1)
  })

  it('旧任务编辑显示未设置目录，加载时不触发保存或自动填值', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    expect(await screen.findByText('该旧任务尚未设置结果输出目录；请选择目录后才能保存。')).toBeTruthy()
    expect(butlerUpdateTask).not.toHaveBeenCalled()
  })

  it('编辑任务回填已保存的输出路径和归档方式', async () => {
    butlerListTasks.mockResolvedValue([task({
      schedule: { kind: 'daily', time: '09:00' },
      outputDir: '/tmp/saved-results',
      outputOrganization: 'hourly'
    })])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))

    expect(await screen.findByLabelText('结果输出目录')).toHaveProperty('value', '/tmp/saved-results')
    expect(selectedArchiveValue()).toBe('每次执行写入按日期和小时（YYYYMMDD-HH）创建的子目录')
    await chooseSelectOption('触发方式', '固定间隔')
    expect(selectedArchiveValue()).toBe('每次执行写入按日期和小时（YYYYMMDD-HH）创建的子目录')
  })

  it('旧任务首次编辑必须补选结果输出目录才可保存', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    await clickTaskSubmit()

    expect(await screen.findByText('请选择结果输出目录')).toBeTruthy()
    expect(butlerUpdateTask).not.toHaveBeenCalled()
  })

  it('旧任务可以只编辑名称、提示词和排程并保留兼容配置', async () => {
    butlerListTasks.mockResolvedValue([task({ modelOverride: 'legacy-provider-model' })])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '改名后的任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '改后的提示词' } })
    await chooseOutputDir('/tmp/output-selected')
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/selected-root' })
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    await screen.findByText('/tmp/selected-root')
    await clickTaskSubmit()
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledTimes(1))
    const payload = butlerUpdateTask.mock.calls[0]![0] as { patch: Record<string, unknown> }
    expect(payload.patch).toMatchObject({ name: '改名后的任务', prompt: '改后的提示词', authorizedDirs: ['/tmp/selected-root'], outputDir: '/tmp/output-selected' })
    expect(payload.patch).not.toHaveProperty('workDir')
    expect(payload.patch).not.toHaveProperty('modelId')
    expect(payload.patch).not.toHaveProperty('modelServiceId')
    expect(payload.patch).not.toHaveProperty('reasoningEffort')
  })

  it('授权目录选择器提交明确路径，用户取消不写入表单', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    const browse = await screen.findByRole('button', { name: '浏览目录' })
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: true })
    fireEvent.click(browse)
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/chosen' })
    fireEvent.click(browse)
    expect(await screen.findByText('/tmp/chosen')).toBeTruthy()
    await chooseOutputDir('/tmp/output-selected')
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
    expect(card!.querySelector('.butler-task-card__output-dir')?.textContent).toContain('未设置（需编辑配置）')
    expect(card!.querySelector('.butler-task-card__output-organization')?.textContent).toContain('未设置')
    expect(card!.querySelectorAll('.butler-task-card__tag')).toHaveLength(2)
    expect(card!.querySelector('.butler-task-card__header .ant-switch')).toBeTruthy()
    expect(card!.querySelector('.butler-task-card__footer')).toBeTruthy()
  })

  it('任务卡显示结果目录与归档方式，并给长路径保留完整 title', async () => {
    const longPath = '/Users/space/Documents/Projects/Quarterly Reports/Exports/Automated Results/October 2026'
    butlerListTasks.mockResolvedValue([task({ outputDir: longPath, outputOrganization: 'hourly', authorizedDirs: ['/tmp/materials'], workDirs: ['/tmp/materials'] })])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())

    const output = document.querySelector('.butler-task-card__output-dir') as HTMLElement
    expect(output.textContent).toContain(longPath)
    expect(output.title).toBe(longPath)
    expect(document.querySelector('.butler-task-card__output-organization')?.textContent).toContain('按日期小时归档')
    expect(document.querySelector('.butler-task-card__authorized-dirs')?.textContent).toContain('/tmp/materials')
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

  it('预检请求期间表单被修改时丢弃旧权限清单', async () => {
    let resolveCreate!: (result: unknown) => void
    butlerCreateTask.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve }))
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '旧任务目标' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '读取旧报告' } })
    await chooseOutputDir()
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '读取新报告' } })
    resolveCreate({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'stale-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'local-shell', scopeRoots: ['/tmp/old-root'], commands: [{ command: 'git log', workingDirectory: '/tmp/old-root' }] }]
    })

    expect(await screen.findByText(/预检期间表单内容已变化/)).toBeTruthy()
    expect(screen.queryByText('请检查此定时任务需要的权限')).toBeNull()
    expect(screen.queryByText('/tmp/old-root')).toBeNull()
    expect(screen.getByRole('button', { name: '预检并查看权限' })).toBeTruthy()
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()
  })

  it('主进程返回 ok:false 时不提示成功、弹窗不关闭、不刷新列表（假成功防护）', async () => {
    butlerCreateTask.mockResolvedValue({ ok: false, error: '任务参数不完整（名称 / 提示词 / 触发方式 / 投递偏好）' })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await waitFor(() => expect(screen.getByLabelText('任务名称')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '会失败的任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: 'x' } })
    await chooseOutputDir()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/chosen-root' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    // 失败分支：不关弹窗、不刷新（成功分支会刷新 → 第 2 次 list 调用）
    expect(screen.getByText('新建定时任务')).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(butlerListTasks).toHaveBeenCalledTimes(1)
  })

  it('预检不可用时把内部错误码转换为可理解的说明', async () => {
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-unavailable', error: 'ANALYZER_UNAVAILABLE' })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '预检服务不可用' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '读取 report.csv' } })
    await chooseOutputDir()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/chosen-root' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await clickTaskSubmit()

    expect(await screen.findByText(/暂时无法调用任务模型完成预检/)).toBeTruthy()
    expect(screen.queryByText('ANALYZER_UNAVAILABLE')).toBeNull()
  })

  it('目录列表可添加多个根并移除单项', async () => {
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '多目录任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '汇总报告' } })
    await chooseOutputDir()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/root-a' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/root-b' })
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    await waitFor(() => expect(screen.getByText('/tmp/root-b')).toBeTruthy())
    expect(screen.getByText('/tmp/root-a')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除目录 /tmp/root-a' }))
    expect(screen.queryByText('/tmp/root-a')).toBeNull()
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ authorizedDirs: ['/tmp/root-b'] })
  })

  it('阻断报告保留表单并列出默认未选候选，勾选后重新提交多根', async () => {
    butlerCreateTask
      .mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_AMBIGUOUS', messageKey: 'butler.preflight.target_ambiguous', reference: 'report.csv', candidates: ['/tmp/root-a/a/report.csv', '/tmp/root-a/b/report.csv'] }], suggestedDirectories: [{ path: '/tmp/suggested', purpose: '报告输入', source: 'prompt', validationStatus: 'valid' }] } })
      .mockResolvedValueOnce({ ok: true, id: 'new-2' })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '预检任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '汇总 /tmp/suggested' } })
    await chooseOutputDir()
    butlerChooseWorkDir.mockResolvedValueOnce({ cancelled: false, path: '/tmp/root-a' })
    fireEvent.click(screen.getByRole('button', { name: '浏览目录' }))
    await clickTaskSubmit()
    const candidate = await screen.findByRole('checkbox', { name: /\/tmp\/suggested/ })
    expect(screen.getByText('相关描述：report.csv')).toBeTruthy()
    expect(screen.getByText('/tmp/root-a/a/report.csv')).toBeTruthy()
    expect(screen.getByText('/tmp/root-a/b/report.csv')).toBeTruthy()
    expect(candidate).toHaveProperty('checked', false)
    expect(screen.getByLabelText('任务名称')).toHaveProperty('value', '预检任务')
    fireEvent.click(candidate)
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(2))
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ authorizedDirs: ['/tmp/root-a'] })
    expect(butlerCreateTask.mock.calls[1]![0]).toMatchObject({ authorizedDirs: ['/tmp/root-a', '/tmp/suggested'] })
  })

  it('启用预检阻断打开编辑表单展示候选，任务保持停用', async () => {
    const disabled = task({ enabled: false, workDirs: ['/tmp/root-a'] })
    butlerListTasks.mockResolvedValue([disabled])
    butlerUpdateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_NOT_FOUND', messageKey: 'butler.preflight.target_not_found' }], suggestedDirectories: [{ path: '/tmp/suggested', purpose: '目标目录', source: 'prompt', validationStatus: 'valid' }] } })
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('编辑定时任务')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /\/tmp\/suggested/ })).toHaveProperty('checked', false)
    expect(butlerUpdateTask.mock.calls[0]![0]).toMatchObject({ patch: { enabled: true } })
  })

  it('启用旧任务需要确认权限时，等编辑窗打开后仍显示待确认清单', async () => {
    const disabled = task({ enabled: false, workDirs: ['/tmp/root-a'] })
    butlerListTasks.mockResolvedValue([disabled])
    butlerUpdateTask.mockResolvedValueOnce({
      ok: false, kind: 'authorization-review-required', reviewId: 'enable-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'directory-read-write', path: '/tmp/root-a' }, { kind: 'result-write', outputDirectory: '/tmp/results', organization: 'hourly' }]
    })
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch'))

    await screen.findByText('编辑定时任务')
    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认授权并保存任务' })).toBeTruthy()
    expect(screen.getByText(/可读取或修改以下目录/)).toBeTruthy()
  })

  it('历史用本地化状态标签展示 skipped 原因', async () => {
    butlerListTasks.mockResolvedValue([task()])
    butlerListTaskRuns.mockResolvedValue([{ id: 'run-skipped', taskId: 'task-1', clientId: 'client', trigger: 'schedule', scheduledFor: 1, status: 'skipped', error: 'missed-window', deliveryStatus: 'none', createdAt: 1, updatedAt: 1 }])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '运行历史' }))
    expect(await screen.findByText(/已跳过/)).toBeTruthy()
    expect(screen.getByText('错过执行窗口')).toBeTruthy()
  })
})
