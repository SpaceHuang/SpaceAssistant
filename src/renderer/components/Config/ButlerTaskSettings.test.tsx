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
    await waitFor(() => expect(screen.getByRole('textbox', { name: /结果输出目录/ })).toHaveProperty('value', path))
  }

  async function clickTaskSubmit() {
    const permissionStep = screen.queryByRole('button', { name: '下一步' })
    if (permissionStep) {
      fireEvent.click(permissionStep)
      fireEvent.click(await screen.findByRole('button', { name: /保存并启用|保存更改|保存并保持停用/ }))
      return
    }
    fireEvent.click(await screen.findByRole('button', { name: /预检并查看权限/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }))
    await chooseSelectOption('结果归档方式', '直接写入该目录')
    await chooseOutputDir('/tmp/draft-results')

    await clickTaskSubmit()
    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))

    cleanup()
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)

    expect(await screen.findByLabelText('任务名称')).toHaveProperty('value', '草稿巡检')
    expect(screen.getByLabelText('任务提示词')).toHaveProperty('value', '读取资料并生成结果')
    expect(screen.getByRole('textbox', { name: /结果输出目录/ })).toHaveProperty('value', '/tmp/draft-results')
    expect(selectedTriggerValue()).toBe('每天')
    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }))
    expect(selectedArchiveValue()).toBe('直接写入该目录')
    expect(screen.queryByText('/tmp/materials')).toBeNull()
    expect(screen.queryByText('请检查此定时任务需要的权限')).toBeNull()
    expect(screen.getByRole('button', { name: '预检并查看权限' })).toBeTruthy()

    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(2))
    expect(butlerCreateTask.mock.calls[1]![0]).toMatchObject({
      name: '草稿巡检',
      prompt: '读取资料并生成结果',
      schedule: { kind: 'daily', time: '09:00' },
      authorizedDirs: [],
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
    expect(screen.getByRole('textbox', { name: /结果输出目录/ })).toHaveProperty('value', '')
  })

  it('编辑任务的预检草稿按任务 ID 恢复', async () => {
    const existing = task({ outputDir: '/tmp/task-results', outputOrganization: 'daily', authorizedDirs: ['/tmp/task-materials'], workDirs: ['/tmp/task-materials'] })
    butlerListTasks.mockResolvedValue([existing])
    butlerUpdateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'edit-review-stale',
      report: { status: 'passed', blockers: [], suggestedDirectories: [], preflightCoverage: 'partial' },
      permissions: [{ kind: 'directory-read-write', path: '/tmp/task-materials' }]
    })

    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '编辑中的草稿' } })
    await clickTaskSubmit()
    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    expect(screen.getByText('模拟演练达到时间或调用预算后，系统已用独立总结会话整理已记录的调用。此清单可能不含未观察到的后续调用；运行时超出清单的权限仍会被拦截，需要重新预检。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))

    cleanup()
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))

    expect(await screen.findByLabelText('任务名称')).toHaveProperty('value', '编辑中的草稿')
    expect(screen.getByRole('textbox', { name: /结果输出目录/ })).toHaveProperty('value', '/tmp/task-results')
    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }))
    expect(selectedArchiveValue()).toBe('每次执行写入按日期（YYYYMMDD）创建的子目录')
    expect(screen.queryByText('/tmp/task-materials')).toBeNull()
    expect(screen.queryByText('请检查此定时任务需要的权限')).toBeNull()
  })

  it('托盘未启用时显示前提提示（P0 决策 a 的 UI 面）', async () => {
    appGetTrayEnabled.mockResolvedValue(false)
    renderTab()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('将完整大模型服务收进高级设置，并在折叠标题显示当前模型', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await screen.findByLabelText('任务名称')

    expect(screen.getAllByRole('region').map((region) => region.querySelector('h5')?.textContent)).toEqual([
      '任务内容',
      '执行计划',
      '结果输出目录（生成结果写入此处） *'
    ])

    const advancedSettings = screen.getByRole('button', { name: /高级设置/ })
    const outputSection = screen.getByRole('region', { name: '结果输出目录（生成结果写入此处）' })
    expect(Boolean(outputSection.compareDocumentPosition(advancedSettings) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(screen.queryByRole('region', { name: '资料与本机访问权限' })).toBeNull()
    expect(advancedSettings.textContent).toContain('model-name · Service')
    expect(advancedSettings.textContent).toContain('归档：按日期小时归档')
    expect(screen.queryByRole('region', { name: '大模型服务' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '结果归档方式' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '投递偏好' })).toBeNull()
    fireEvent.click(advancedSettings)
    expect(screen.getByRole('combobox', { name: '结果归档方式' })).toBeTruthy()
    const modelServiceSection = screen.getByRole('region', { name: '大模型服务' })
    expect(within(modelServiceSection).getByRole('combobox', { name: '任务模型与服务' })).toBeTruthy()
    expect(within(modelServiceSection).getByRole('combobox', { name: '思维强度' })).toBeTruthy()
    const deliverySection = screen.getByRole('region', { name: '结果投递' })
    expect(within(deliverySection).getByRole('combobox', { name: '投递偏好' })).toBeTruthy()
  })

  it('未选择任务模型时提交会自动展开高级设置并定位校验错误', async () => {
    butlerGetTaskDefaults.mockResolvedValueOnce({ workDir: '/tmp/active-profile' })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await screen.findByLabelText('任务名称')

    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '测试任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '生成测试结果' } })
    await chooseOutputDir('/tmp/output')
    fireEvent.click(screen.getByRole('button', { name: /预检并查看权限/ }))

    const modelServiceSection = await screen.findByRole('region', { name: '大模型服务' })
    expect(within(modelServiceSection).getByRole('combobox', { name: '任务模型与服务' }).getAttribute('aria-invalid')).toBe('true')
    expect(butlerCreateTask).not.toHaveBeenCalled()
  })

  it('预检结果出现后聚焦权限清单，用户无需回到表单顶部寻找', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'review-focus',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [
        { kind: 'local-shell', scopeRoots: ['/tmp/project'], commands: [{ command: 'git log --oneline -5', workingDirectory: '/tmp/project' }] }
      ]
    })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '权限检查任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '总结 Git 提交' } })
    await chooseOutputDir()
    await clickTaskSubmit()

    const review = await screen.findByRole('region', { name: '请检查此定时任务需要的权限' })
    await waitFor(() => expect(document.activeElement).toBe(review))
    expect(within(review).getByText(/git log --oneline -5/)).toBeTruthy()
  })

  it('表单校验失败后聚焦第一个必填项', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    const nameInput = await screen.findByLabelText('任务名称')
    await clickTaskSubmit()

    await waitFor(() => expect(document.activeElement).toBe(nameInput))
    expect(butlerCreateTask).not.toHaveBeenCalled()
  })

  it('新建任务：提交后调用 butlerCreateTask 并刷新列表', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false, kind: 'authorization-review-required', reviewId: 'review-1',
      report: { status: 'blocked', blockers: [{
        code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required', field: 'workDirs',
        reasonCode: 'output_root_not_read_authorized', reference: '读取本地 Git 仓库', candidates: ['/tmp/output-root']
      }], suggestedDirectories: [{ path: '/tmp/output-root', purposeKey: 'butler.preflight.output_root_read_candidate_purpose', source: '读取本地 Git 仓库', validationStatus: 'valid' }] },
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
    expect(screen.queryByRole('checkbox', { name: '允许本地 Shell 命令' })).toBeNull()
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    const permissionReview = screen.getByRole('region', { name: '请检查此定时任务需要的权限' })
    expect(within(permissionReview).getByText('预检发现')).toBeTruthy()
    expect(within(permissionReview).getByText('任务需要读取所选结果输出目录中的 Git 仓库；这项访问权限与结果写入分开列出。')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '预检结果' })).toBeNull()
    expect(screen.queryByText('这项任务需要本机工具权限。请查看下方权限需求，并将相关资料目录加入授权读写列表后重新预检。')).toBeNull()
    const permissionsTable = screen.getByRole('table')
    expect(within(permissionsTable).getByRole('columnheader', { name: '权限类型' })).toBeTruthy()
    expect(within(permissionsTable).getByRole('columnheader', { name: '授权对象' })).toBeTruthy()
    expect(within(permissionsTable).getByRole('columnheader', { name: '范围与限制' })).toBeTruthy()
    expect(within(permissionsTable).getByText('本机 Shell')).toBeTruthy()
    expect(within(permissionsTable).getByText('git log --oneline -5')).toBeTruthy()
    expect(within(permissionsTable).getByText('工作目录')).toBeTruthy()
    expect(within(permissionsTable).getByText('执行超时')).toBeTruthy()
    expect(screen.queryByText(/超时：30s/)).toBeNull()
    expect(within(permissionsTable).getByText('grep 搜索')).toBeTruthy()
    expect(within(permissionsTable).getByText('/tmp/chosen-root/src')).toBeTruthy()
    expect(within(permissionsTable).getByText('脚本运行')).toBeTruthy()
    expect(within(permissionsTable).getByText(/SHA-256/)).toBeTruthy()
    expect(within(permissionsTable).getByText('MCP 工具')).toBeTruthy()
    expect(within(permissionsTable).getByText('Issue Tracker')).toBeTruthy()
    expect(within(permissionsTable).getByText('search_issues')).toBeTruthy()
    expect(within(permissionsTable).getByText('查找近期问题')).toBeTruthy()
    expect(within(permissionsTable).getByText('query')).toBeTruthy()
    expect(within(permissionsTable).getByText(/服务配置与工具定义/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '我同意授权以上全部权限' })).toBeNull()
    expect(within(screen.getByRole('region', { name: '请检查此定时任务需要的权限' })).queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', false)
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()
    const payload = butlerCreateTask.mock.calls[0]![0] as { name: string; prompt: string; schedule: unknown; authorizedDirs: string[]; outputDir: string; outputOrganization: string; enabled: boolean }
    expect(payload.name).toBe('周报汇总')
    expect(payload.prompt).toBe('汇总本周会话')
    expect(payload.schedule).toEqual({ kind: 'interval', intervalMinutes: 30 })
    expect(payload).toMatchObject({ authorizedDirs: [], outputDir: '/tmp/output-root', outputOrganization: 'hourly', enabled: false, modelId: 'model-1', modelServiceId: 'service-1', modelOverride: 'model-name', reasoningEffort: 'medium' })
    expect(payload).not.toHaveProperty('accessPermissions')
    await clickTaskSubmit()
    await waitFor(() => expect(butlerConfirmTaskAuthorization).toHaveBeenCalledWith({ reviewId: 'review-1' }))
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledWith({ id: 'new-1', patch: { enabled: true } }))
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
  })

  it('输出目录 Git 读取阻断时展示整批权限清单并只允许全批确认', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'output-git-review',
      report: {
        status: 'blocked',
        blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required', reasonCode: 'output_root_not_read_authorized', candidates: ['/tmp/project'] }],
        suggestedDirectories: [{ path: '/tmp/project', purposeKey: 'butler.preflight.output_root_read_candidate_purpose', source: 'Git 历史', validationStatus: 'valid' }]
      },
      permissions: [
        { kind: 'directory-read-write', path: '/tmp/project' },
        { kind: 'result-write', outputDirectory: '/tmp/project', organization: 'daily' },
        { kind: 'local-shell', scopeRoots: ['/tmp/project'], commands: [{ command: 'git log --oneline -5', workingDirectory: '/tmp/project' }] }
      ]
    })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: 'Git 汇总' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '总结本机 Git 历史' } })
    await chooseOutputDir('/tmp/project')
    await clickTaskSubmit()

    expect(await screen.findByText(/任务需要读取所选结果输出目录中的 Git 仓库/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: '预检结果' })).toBeNull()
    const permissionsTable = screen.getByRole('table')
    expect(within(permissionsTable).getByText('git log --oneline -5')).toBeTruthy()
    expect(within(permissionsTable).getAllByText('/tmp/project').length).toBeGreaterThanOrEqual(2)
    expect(within(permissionsTable).getByText('资料目录读写')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '我同意授权以上全部权限' })).toBeNull()
    expect(within(screen.getByRole('region', { name: '请检查此定时任务需要的权限' })).queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', false)
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(document.querySelector('.butler-task-editor__steps .ant-steps-item-process .ant-steps-item-title')?.textContent).toBe('最终确认')
    expect(screen.getByText('确认任务设置')).toBeTruthy()
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))
    await waitFor(() => expect(butlerConfirmTaskAuthorization).toHaveBeenCalledWith({ reviewId: 'output-git-review' }))
  })

  it('用三步向导分开展示任务填写、权限确认和最终启用', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'wizard-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'result-write', outputDirectory: '/tmp/wizard-results', organization: 'direct' }]
    })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '向导测试任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '整理资料并生成摘要' } })
    await chooseOutputDir('/tmp/wizard-results')

    expect(screen.getByText('填写任务内容')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '预检并查看权限' }))

    const permissionReview = await screen.findByRole('region', { name: '请检查此定时任务需要的权限' })
    expect(screen.queryByLabelText('任务名称')).toBeNull()
    expect(within(permissionReview).getByRole('table')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '我同意授权以上全部权限' })).toBeNull()
    expect(within(permissionReview).queryByRole('alert')).toBeNull()
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('确认任务设置')).toBeTruthy()
    expect(screen.getByText('向导测试任务')).toBeTruthy()
    expect(screen.getByText('/tmp/wizard-results')).toBeTruthy()
    const enableTask = screen.getByRole('switch', { name: '保存后启用任务' })
    expect(enableTask.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(enableTask)
    expect(screen.getByRole('button', { name: '保存并保持停用' })).toBeTruthy()
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '保存并保持停用' }))
    await waitFor(() => expect(butlerConfirmTaskAuthorization).toHaveBeenCalledWith({ reviewId: 'wizard-review' }))
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledWith({ id: 'new-1', patch: { enabled: false } }))
    await waitFor(() => expect(screen.queryByLabelText('任务名称')).toBeNull())
  })

  it('新建任务在第三步保留启用选择，并将启用状态写入列表数据', async () => {
    const enabledTask = task({
      id: 'created-enabled',
      name: '启用任务',
      enabled: true,
      taskRevision: 1,
      outputDir: '/tmp/enabled-results',
      outputOrganization: 'daily'
    })
    butlerListTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([enabledTask])
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'enabled-create-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'result-write', outputDirectory: '/tmp/enabled-results', organization: 'daily' }]
    })
    butlerConfirmTaskAuthorization.mockResolvedValueOnce({
      ok: true,
      id: 'created-enabled',
      // The confirmation response does not represent the user's separate final activation choice.
      task: enabledTask
    })
    butlerUpdateTask.mockResolvedValueOnce({ ok: true, id: 'created-enabled', task: enabledTask })

    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '启用任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '生成结果' } })
    await chooseOutputDir('/tmp/enabled-results')
    fireEvent.click(screen.getByRole('button', { name: '预检并查看权限' }))
    await screen.findByRole('region', { name: '请检查此定时任务需要的权限' })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    expect(screen.getByRole('switch', { name: '保存后启用任务' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))

    await waitFor(() => expect(butlerConfirmTaskAuthorization).toHaveBeenCalledWith({ reviewId: 'enabled-create-review' }))
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledWith({
      id: 'created-enabled',
      patch: { enabled: true, expectedTaskRevision: 1 }
    }))
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('switch', { name: '启停任务「启用任务」' }).getAttribute('aria-checked')).toBe('true')
  })

  it('最终确认复核阻断时回到任务内容，修正后可重新预检并保存', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'blocked-final-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'result-write', outputDirectory: '/tmp/blocked-results', organization: 'direct' }]
    }).mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'recovered-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'result-write', outputDirectory: '/tmp/blocked-results', organization: 'direct' }]
    })
    butlerConfirmTaskAuthorization.mockResolvedValueOnce({
      ok: false,
      kind: 'preflight-blocked',
      error: '最终复核未通过',
      report: {
        status: 'blocked',
        blockers: [{ code: 'TARGET_UNCLEAR', messageKey: 'butler.preflight.target_unclear', reference: '整理资料' }],
        suggestedDirectories: []
      }
    }).mockResolvedValueOnce({ ok: true, id: 'new-1' })

    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '复核失败任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '整理资料' } })
    await chooseOutputDir('/tmp/blocked-results')

    fireEvent.click(screen.getByRole('button', { name: '预检并查看权限' }))
    await screen.findByRole('region', { name: '请检查此定时任务需要的权限' })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('确认任务设置')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '预检结果' })).toBeNull()
    expect(screen.getByLabelText('任务名称')).toHaveProperty('value', '复核失败任务')
    expect(screen.getByText('无法确定要处理的文件、目录或范围，请在任务提示词中补充具体目标。')).toBeTruthy()
    expect(screen.getByText('相关描述：整理资料')).toBeTruthy()
    expect(screen.getByRole('button', { name: '预检并查看权限' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下一步' })).toBeNull()
    expect(butlerConfirmTaskAuthorization).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '整理 /tmp/target 目录下的文件' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('region', { name: '预检结果' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '预检并查看权限' }))
    await screen.findByRole('region', { name: '请检查此定时任务需要的权限' })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))

    await waitFor(() => expect(butlerConfirmTaskAuthorization).toHaveBeenCalledWith({ reviewId: 'recovered-review' }))
    await waitFor(() => expect(screen.queryByLabelText('任务名称')).toBeNull())
  })

  it('最终确认票据失效时回到任务内容并允许重新预检', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'expiring-wizard-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'result-write', outputDirectory: '/tmp/expiring-results', organization: 'direct' }]
    })
    butlerConfirmTaskAuthorization.mockResolvedValueOnce({
      ok: false,
      kind: 'validation-error',
      error: '权限确认已过期，请重新预检任务'
    })

    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '票据过期任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '生成结果' } })
    await chooseOutputDir('/tmp/expiring-results')
    fireEvent.click(screen.getByRole('button', { name: '预检并查看权限' }))
    await screen.findByRole('region', { name: '请检查此定时任务需要的权限' })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))

    expect(await screen.findByText(/权限确认已过期，请重新预检任务/)).toBeTruthy()
    expect(await screen.findByLabelText('任务名称')).toHaveProperty('value', '票据过期任务')
    expect(screen.getByRole('button', { name: '预检并查看权限' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下一步' })).toBeNull()
  })

  it('编辑停用任务可在最终确认步骤选择启用', async () => {
    const existing = task({ enabled: false, outputDir: '/tmp/disabled-results', outputOrganization: 'direct' })
    butlerListTasks.mockResolvedValue([existing])
    butlerConfirmTaskAuthorization.mockResolvedValueOnce({ ok: true, id: existing.id, task: { ...existing, taskRevision: 1 } })
    butlerUpdateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'authorization-review-required',
      reviewId: 'disabled-edit-review',
      report: { status: 'passed', blockers: [], suggestedDirectories: [] },
      permissions: [{ kind: 'result-write', outputDirectory: '/tmp/disabled-results', organization: 'direct' }]
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: /编辑/ }))
    await screen.findByLabelText('任务名称')
    await clickTaskSubmit()

    expect(await screen.findByText('请检查此定时任务需要的权限')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '我同意授权以上全部权限' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(document.querySelector('.butler-task-editor__steps .ant-steps-item-process .ant-steps-item-title')?.textContent).toBe('最终确认')
    const enableTask = screen.getByRole('switch', { name: '保存后启用任务' })
    expect(enableTask.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(enableTask)
    expect(screen.getByRole('button', { name: '保存并启用' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))

    await waitFor(() => expect(butlerConfirmTaskAuthorization).toHaveBeenCalledWith({ reviewId: 'disabled-edit-review' }))
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledTimes(2))
    expect(butlerUpdateTask.mock.calls[1]![0]).toMatchObject({ id: 'task-1', patch: { enabled: true } })
    const initialPatch = butlerUpdateTask.mock.calls[0]![0].patch as Record<string, unknown>
    expect(initialPatch).not.toHaveProperty('enabled')
    await waitFor(() => expect(screen.queryByLabelText('任务名称')).toBeNull())
  })

  it('新建任务必须选择结果输出目录，访问范围由预检决定', async () => {
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '只输出任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '生成摘要' } })
    expect(screen.getByRole('heading', { name: '结果输出目录（生成结果写入此处）' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /结果输出目录/ })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '结果输出' })).toBeNull()
    expect(screen.queryByText('生成结果写入此目录。')).toBeNull()
    await clickTaskSubmit()

    expect(await screen.findByText('请选择结果输出目录')).toBeTruthy()
    expect(screen.queryByText('请选择任务工作目录')).toBeNull()
    expect(butlerCreateTask).not.toHaveBeenCalled()
  })

  it('第一步不展示资料与本机访问权限输入项，权限由预检阶段统一列出', async () => {
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)

    expect(await screen.findByLabelText('任务名称')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '资料与本机访问权限' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加授权目录' })).toBeNull()
    expect(screen.queryByText('读取或修改资料时添加对应目录；留空表示不访问其他目录。')).toBeNull()
  })

  it('归档方式默认跟随触发类型，用户手动更改后不再覆盖', async () => {
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    await screen.findByLabelText('任务名称')

    await chooseSelectOption('触发方式', '每天')
    expect(selectedTriggerValue()).toBe('每天')
    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }))
    expect(await screen.findByText('当前模型不支持思维强度设置。')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '思维强度' }).closest('.ant-select')?.classList.contains('ant-select-disabled')).toBe(true)
    await chooseOutputDir()
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ reasoningEffort: 'off' })
  })

  it('TARGET_UNCLEAR 时停留在预检步骤，并可返回修改任务内容', async () => {
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_UNCLEAR', messageKey: 'butler.preflight.target_unclear', reference: '帮我处理一下', reasonCode: 'scope_unclear' }], suggestedDirectories: [] } })
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '待补充目标' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '帮我处理一下' } })
    await chooseOutputDir()
    await clickTaskSubmit()
    await waitFor(() => expect(butlerCreateTask).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('无法确定要处理的文件、目录或范围，请在任务提示词中补充具体目标。')).toBeTruthy()
    expect(screen.getByText('相关描述：帮我处理一下')).toBeTruthy()
    expect(screen.queryByLabelText('任务提示词')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '上一步：填写任务内容' }))
    expect(screen.getByLabelText('任务提示词')).toHaveProperty('value', '帮我处理一下')
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ name: '待补充目标' })
    expect(butlerListTasks).toHaveBeenCalledTimes(1)
  })

  it('Git 查询缺少仓库位置时提示用户补充目标位置', async () => {
    const prompt = '总结一下昨天合并进main分支，并推送github的所有内容。'
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: {
      status: 'blocked', blockers: [{ code: 'TARGET_NOT_FOUND', messageKey: 'butler.preflight.target_not_found', reference: prompt, reasonCode: 'git_repository_not_found' }], suggestedDirectories: []
    } })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: 'Git 提交汇总' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: prompt } })
    await chooseOutputDir()
    await clickTaskSubmit()

    expect(await screen.findByText('在当前可访问范围内没有找到这个目标。请检查名称，并在任务提示词中说明目标位置。')).toBeTruthy()
    expect(screen.getByText('没有识别到目标 Git 仓库。请在任务提示词中说明仓库位置，或把结果输出目录设为仓库所在目录后重新预检。')).toBeTruthy()
    expect(screen.getByText(`相关描述：${prompt}`)).toBeTruthy()
    expect(screen.getByText('返回上一步补充任务提示词或调整结果输出目录，再重新预检。')).toBeTruthy()
    expect(butlerCreateTask).toHaveBeenCalledTimes(1)
  })

  it('权限预检被阻断时展示已检测到但尚未授权的工具需求', async () => {
    const fullCommand = 'cd "/tmp/project/daily" && git rev-parse --show-toplevel && git remote -v && git log origin/main --merges --since="yesterday 00:00" --until="today 00:00" --date=iso --pretty=format:"%h%x09%ad%x09%an%x09%s" | head -200 && echo "--- sync check ---" && git rev-parse main origin/main && git log origin/main -1 --date=iso --pretty=format:"%h %ad %s"'
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'preflight-blocked',
      report: {
        status: 'blocked',
        blockers: [{ code: 'TOOL_PERMISSION_REQUIRED', messageKey: 'butler.preflight.tool_permission_required' }],
        suggestedDirectories: [],
        permissionNeeds: [
          { kind: 'directory-read-write', path: '/tmp/project/daily' },
          { kind: 'local-shell', scopeRoots: ['/tmp/project/daily'], commands: [{ command: fullCommand, workingDirectory: '/tmp/project/daily' }] },
          { kind: 'grep', scopeRoots: ['/tmp/project/daily/docs'] },
          { kind: 'run-script', scopeRoots: ['/tmp/project/daily'], scriptHashBinding: 'per-invocation' }
        ]
      }
    } as never)
    renderTab()
    await waitFor(() => expect(butlerListTasks).toHaveBeenCalled())
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: 'Git 汇总' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '总结本机 Git 历史' } })
    await chooseOutputDir('/tmp/results')
    await clickTaskSubmit()

    expect(await screen.findByText('预检识别到的工具需求（尚未授权）')).toBeTruthy()
    const permissionTable = screen.getByRole('table')
    expect(within(permissionTable).getByRole('columnheader', { name: '权限类型' })).toBeTruthy()
    expect(within(permissionTable).getByRole('columnheader', { name: '授权对象' })).toBeTruthy()
    expect(within(permissionTable).getByRole('columnheader', { name: '范围与限制' })).toBeTruthy()
    expect(within(permissionTable).getAllByText('/tmp/project/daily').length).toBeGreaterThan(0)
    expect(within(permissionTable).getByText('本机 Shell')).toBeTruthy()
    expect(within(permissionTable).getByText('工作目录')).toBeTruthy()
    const commandPreview = within(permissionTable).getByText(/^git log origin\/main --merges --since="yesterday 00:00"/)
    expect(within(permissionTable).queryByText(fullCommand)).toBeNull()
    fireEvent.mouseEnter(commandPreview)
    expect((await screen.findByRole('tooltip')).textContent).toContain(fullCommand)
    expect(within(permissionTable).getByText('grep 搜索')).toBeTruthy()
    expect(within(permissionTable).getByText('脚本运行')).toBeTruthy()
    expect(within(permissionTable).getByText(/SHA-256/)).toBeTruthy()
    expect(screen.queryByText(/可运行列出的本机命令及完整参数/)).toBeNull()
    expect(screen.getByText('这些需求来自模拟演练，尚未授权。请核对完整范围后继续确认；运行时仍会逐次校验工具调用及参数。')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '我同意授权以上全部权限' })).toBeNull()
    expect(butlerConfirmTaskAuthorization).not.toHaveBeenCalled()
  })

  it('模型没有返回具体工具范围时不承诺显示权限清单', async () => {
    butlerCreateTask.mockResolvedValueOnce({
      ok: false,
      kind: 'preflight-blocked',
      report: {
        status: 'blocked',
        blockers: [{ code: 'TOOL_PERMISSION_DETAILS_MISSING', messageKey: 'butler.preflight.tool_permission_details_missing', reasonCode: 'capability_not_authorized' }],
        suggestedDirectories: []
      }
    } as never)
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '工具需求缺少范围' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '总结本机项目的近期改动' } })
    await chooseOutputDir('/tmp/results')
    await clickTaskSubmit()

    expect(await screen.findByText('预检判断任务可能需要本机工具，但没有记录到具体调用及参数，无法形成可确认的权限清单。任务尚未保存。请重试预检；若再次出现，请反馈应用维护人员。')).toBeTruthy()
    expect(screen.queryByText('任务需要本地 Shell 命令权限，但当前尚未授权。')).toBeNull()
    expect(screen.queryByText('预检识别到的工具需求（尚未授权）')).toBeNull()
  })

  it('旧任务编辑显示未设置目录，加载时不触发保存或自动填值', async () => {
    butlerListTasks.mockResolvedValue([task()])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    const legacyNotice = '该旧任务尚未设置结果输出目录；请选择目录后才能保存。'
    expect(await screen.findByText(legacyNotice)).toBeTruthy()
    expect(butlerUpdateTask).not.toHaveBeenCalled()

    await chooseOutputDir('/tmp/legacy-task-results')
    expect(screen.queryByText(legacyNotice)).toBeNull()
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

    expect(await screen.findByRole('textbox', { name: /结果输出目录/ })).toHaveProperty('value', '/tmp/saved-results')
    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }))
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
    await clickTaskSubmit()
    await waitFor(() => expect(butlerUpdateTask).toHaveBeenCalledTimes(2))
    const payload = butlerUpdateTask.mock.calls[0]![0] as { patch: Record<string, unknown> }
    expect(payload.patch).toMatchObject({ name: '改名后的任务', prompt: '改后的提示词', authorizedDirs: [], outputDir: '/tmp/output-selected' })
    expect(payload.patch).not.toHaveProperty('workDir')
    expect(payload.patch).not.toHaveProperty('modelId')
    expect(payload.patch).not.toHaveProperty('modelServiceId')
    expect(payload.patch).not.toHaveProperty('reasoningEffort')
    expect(butlerUpdateTask.mock.calls[1]![0]).toMatchObject({ id: 'task-1', patch: { enabled: true } })
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

  it('停用任务明确标记状态且仅禁用立即运行；仍可编辑', async () => {
    butlerListTasks.mockResolvedValue([task({ enabled: false })])
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    expect(document.querySelector('.butler-task-card--disabled')).toBeTruthy()
    expect(screen.getByText('已停用')).toBeTruthy()
    expect(screen.getByRole('button', { name: '立即运行' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '运行历史' })).toHaveProperty('disabled', false)
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
    expect(await screen.findByLabelText('任务提示词')).toHaveProperty('value', '读取新报告')
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
    await clickTaskSubmit()

    expect(await screen.findByText(/预检服务暂时无法完成请求，任务尚未保存/)).toBeTruthy()
    expect(screen.queryByText('ANALYZER_UNAVAILABLE')).toBeNull()
  })

  it('预检无法确认目标和权限范围时给出用户可理解的说明，不暴露内部原因码', async () => {
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-unavailable', error: 'ANALYZER_INVALID_RESPONSE' })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '权限校验诊断' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '读取 report.csv' } })
    await chooseOutputDir()
    await clickTaskSubmit()

    expect(await screen.findByText(/预检无法可靠确认任务目标和所需访问范围，任务尚未保存/)).toBeTruthy()
    expect(screen.queryByText('ANALYZER_INVALID_RESPONSE')).toBeNull()
  })

  it('预检模型回复被截断时向用户说明结果不完整', async () => {
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-unavailable', error: 'ANALYZER_OUTPUT_TRUNCATED' })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '总结输出诊断' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '读取 report.csv' } })
    await chooseOutputDir()
    await clickTaskSubmit()

    expect(await screen.findByText(/未能在本次请求的输出长度内完整返回结果/)).toBeTruthy()
    expect(screen.queryByText('ANALYZER_OUTPUT_TRUNCATED')).toBeNull()
  })

  it('阻断报告在预检步骤列出歧义路径，不允许逐个勾选建议目录', async () => {
    butlerCreateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_AMBIGUOUS', messageKey: 'butler.preflight.target_ambiguous', reference: 'report.csv', candidates: ['/tmp/root-a/a/report.csv', '/tmp/root-a/b/report.csv'] }], suggestedDirectories: [{ path: '/tmp/suggested', purpose: '报告输入', source: 'prompt', validationStatus: 'valid' }] } })
    renderTab()
    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)
    fireEvent.change(await screen.findByLabelText('任务名称'), { target: { value: '预检任务' } })
    fireEvent.change(screen.getByLabelText('任务提示词'), { target: { value: '汇总 /tmp/suggested' } })
    await chooseOutputDir()
    await clickTaskSubmit()
    expect(await screen.findByText('相关描述：report.csv')).toBeTruthy()
    expect(screen.getByText('/tmp/root-a/a/report.csv')).toBeTruthy()
    expect(screen.getByText('/tmp/root-a/b/report.csv')).toBeTruthy()
    expect(screen.queryByLabelText('任务名称')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '上一步：填写任务内容' }))
    expect(screen.getByLabelText('任务名称')).toHaveProperty('value', '预检任务')
    expect(screen.queryByRole('checkbox', { name: /\/tmp\/suggested/ })).toBeNull()
    expect(screen.queryByText('/tmp/suggested')).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(butlerCreateTask).toHaveBeenCalledTimes(1)
    expect(butlerCreateTask.mock.calls[0]![0]).toMatchObject({ authorizedDirs: [] })
  })

  it('启用预检阻断打开编辑表单展示候选，任务保持停用', async () => {
    const disabled = task({ enabled: false, workDirs: ['/tmp/root-a'] })
    butlerListTasks.mockResolvedValue([disabled])
    butlerUpdateTask.mockResolvedValueOnce({ ok: false, kind: 'preflight-blocked', report: { status: 'blocked', blockers: [{ code: 'TARGET_NOT_FOUND', messageKey: 'butler.preflight.target_not_found' }], suggestedDirectories: [{ path: '/tmp/suggested', purpose: '目标目录', source: 'prompt', validationStatus: 'valid' }] } })
    renderTab()
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('编辑定时任务')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /\/tmp\/suggested/ })).toBeNull()
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
    expect(screen.getByRole('button', { name: '下一步' })).toBeTruthy()
    const permissionsTable = screen.getByRole('table')
    expect(within(permissionsTable).getByText('资料目录读写')).toBeTruthy()
    expect(within(permissionsTable).getByText('/tmp/root-a')).toBeTruthy()
    expect(within(permissionsTable).getByText('结果目录写入')).toBeTruthy()
    expect(within(permissionsTable).getByText('/tmp/results')).toBeTruthy()
    expect(within(permissionsTable).getByText('按日期小时归档')).toBeTruthy()
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
