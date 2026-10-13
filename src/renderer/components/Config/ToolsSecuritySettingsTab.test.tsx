import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ToolsSecuritySettingsTab } from './ToolsSecuritySettingsTab'
import configReducer from '../../store/configSlice'
import { changeAppLocale } from '../../i18n/localeSync'
import type { SecuritySettingsModelPayload } from '../../../shared/confirmation/settingsCenter'
import { DEFAULT_BROWSER_CONFIG } from '../../../shared/domainTypes'

const MODEL: SecuritySettingsModelPayload = {
  packages: { desktop: 'standard', wechat: 'standard', feishu: 'standard', automation: 'standard' },
  deniedTools: [],
  memoryEntries: [],
  audit: { retentionDays: 180, haveAuditLog: true },
  rules: [
    {
      id: 'im-write-ask',
      when: 'invocation',
      action: 'ask',
      defaultAction: 'ask',
      enabled: true,
      locked: false,
      reason: '远程链路写本地文件默认需要确认',
      overridden: false,
      lanes: ['wechat', 'feishu']
    },
    {
      id: 'remote-shell-disabled',
      when: 'invocation',
      action: 'deny',
      defaultAction: 'deny',
      enabled: true,
      locked: true,
      reason: 'SHELL_REMOTE_DISABLED',
      overridden: false,
      lanes: ['wechat', 'feishu']
    },
    {
      id: 'script-clean-allow-desktop',
      when: 'invocation',
      action: 'allow',
      defaultAction: 'allow',
      enabled: true,
      locked: false,
      reason: '桌面 clean 脚本免确认',
      overridden: false,
      lanes: ['desktop']
    },
    {
      // 通用 ask 规则：desktop standard 下生效动作为「自动」（渲染端 effectiveActionFor 计算）
      id: 'mcp-tool-ask',
      when: 'invocation',
      action: 'ask',
      defaultAction: 'ask',
      enabled: true,
      locked: false,
      reason: 'MCP 工具调用需确认',
      overridden: false
    },
    {
      id: 'shell-precheck-auto-allow',
      when: 'invocation',
      action: 'auto-evaluator',
      defaultAction: 'auto-evaluator',
      enabled: true,
      locked: false,
      reason: 'shell 预检判定可跳过确认',
      overridden: false
    },
    {
      id: 'universal-no-lane',
      when: 'invocation',
      action: 'ask',
      defaultAction: 'ask',
      enabled: true,
      locked: false,
      reason: '无 lane 限定的通用规则应出现在每个链路 Tab',
      overridden: false
    }
  ]
}

function renderTab(overrides?: {
  browser?: typeof DEFAULT_BROWSER_CONFIG
  onBrowserChange?: (next: typeof DEFAULT_BROWSER_CONFIG) => void
}) {
  const store = configureStore({ reducer: { config: configReducer } })
  render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <ToolsSecuritySettingsTab
            active
            browser={overrides?.browser ?? DEFAULT_BROWSER_CONFIG}
            onBrowserChange={overrides?.onBrowserChange ?? (() => {})}
          />
        </App>
      </ConfigProvider>
    </Provider>
  )
}

/** 切到指定链路 Tab 并等待其规则表出现。 */
async function openLaneTab(name: string) {
  fireEvent.click(await screen.findByRole('tab', { name }))
  return screen.findByRole('tabpanel')
}

describe('ToolsSecuritySettingsTab（§7 五区）', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    window.api = {
      ...window.api,
      securityGetSettingsModel: vi.fn().mockResolvedValue(MODEL),
      securityReadPolicyForLane: vi.fn().mockResolvedValue({
        domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 5, snapshot: { selectedPackage: 'standard' }
      }),
      securityWritePolicy: vi.fn().mockResolvedValue({ status: 'committed', revision: 6 }),
      securitySetImAutoReviewTestMode: vi.fn().mockImplementation(async ({ enabled }) => ({ enabled })),
      securitySetPolicyPackage: vi.fn().mockResolvedValue({ ok: true }),
      securitySetRuleOverride: vi.fn().mockResolvedValue({ ok: true }),
      securitySetRuleEnabled: vi.fn().mockResolvedValue({ ok: true }),
      securityRemoveRuleOverride: vi.fn().mockResolvedValue({ ok: true, removed: 1 }),
      securityListDecisionCache: vi.fn().mockResolvedValue([
        {
          id: 'c1',
          key: { kind: 'shell-command', verb: 'git status', level: 'exact' },
          decision: 'allow',
          lane: '*',
          scope: 'persistent',
          createdAt: 1,
          lastHitAt: 1,
          hitCount: 2,
          source: 'user-confirm'
        }
      ]),
      securityClearDecisionCache: vi.fn().mockResolvedValue({ ok: true, cleared: 1 }),
      securityQueryAudit: vi.fn().mockResolvedValue([]),
      securityGetAuditRetention: vi.fn().mockResolvedValue(180),
      securitySetAuditRetention: vi.fn().mockResolvedValue({ ok: true })
    } as typeof window.api
  })

  it('IM 套餐写入共同策略快照并携带读取到的 revision', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await openLaneTab('IM 远程')
    const packageSelect = (await within(panel).findAllByRole('combobox'))[0]!
    fireEvent.mouseDown(packageSelect)
    fireEvent.click(await screen.findByText('严格'))
    await waitFor(() => {
      expect(window.api.securityWritePolicy).toHaveBeenCalledWith({
        lane: 'wechat', expectedRevision: 5, change: { kind: 'package', package: 'strict' }
      })
    })
    expect(window.api.securitySetPolicyPackage).not.toHaveBeenCalledWith({ lane: 'wechat', package: 'strict' })
  })

  it('旧版 IM 策略必须展示差异并经用户确认后切换新版标准', { timeout: 20000 }, async () => {
    window.api.securityReadPolicyForLane = vi.fn().mockResolvedValue({
      domain: 'im', policyBehaviorVersion: 'im-v1.6', revision: 5, snapshot: { selectedPackage: 'standard' }
    })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    fireEvent.click(await within(panel).findByRole('button', { name: '查看变化并切换' }))
    expect(await screen.findByText(/公开网页抓取等已分类的只读 MCP 调用/)).toBeTruthy()
    expect(screen.getByText(/标准策略会按规则把适合自动审核的操作交给审核 Agent/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '我已查看变化，确认切换' }))
    await waitFor(() => {
      expect(window.api.securityWritePolicy).toHaveBeenCalledWith({
        lane: 'wechat', expectedRevision: 5,
        change: {
          kind: 'switch-to-standard', userChoiceConfirmed: true,
          displayedDiffs: [
            'mcp-public-read-auto',
            'low-risk-browser-and-feishu-auto',
            'sensitive-write-and-external-outbound-manual'
          ]
        }
      })
    })
  })

  it('IM 套餐展示共同快照中的选择值，不被旧设置模型覆盖', { timeout: 20000 }, async () => {
    window.api.securityGetSettingsModel = vi.fn().mockResolvedValue({
      ...MODEL, packages: { ...MODEL.packages, wechat: 'standard' }
    })
    window.api.securityReadPolicyForLane = vi.fn().mockResolvedValue({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 8, snapshot: { selectedPackage: 'strict' }
    })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    await waitFor(() => expect(within(panel).getByText('严格')).toBeTruthy())
  })

  it('IM 自动审核门禁关闭时显示未启用状态和快照原因', { timeout: 20000 }, async () => {
    window.api.securityReadPolicyForLane = vi.fn().mockResolvedValue({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 8,
      snapshot: { selectedPackage: 'standard', enabled: false, disabledReason: 'rollback_required' }
    })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    expect(await within(panel).findByText('异步人工审批通知尚未启用')).toBeTruthy()
    expect(within(panel).getByText('正式渠道的安全关闭或回退状态仍生效。')).toBeTruthy()
  })

  it('开发实例显示自动审核测试开关并将选择写入主进程', { timeout: 20000 }, async () => {
    window.api.securityReadPolicyForLane = vi.fn().mockResolvedValue({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 5,
      snapshot: { selectedPackage: 'standard', enabled: false, developmentAutoReviewTestAvailable: true, developmentAutoReviewTestEnabled: false }
    })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    expect(within(panel).getByText('开发测试：自动审核')).toBeTruthy()
    fireEvent.click(within(panel).getAllByRole('switch')[0]!)
    await waitFor(() => expect(window.api.securitySetImAutoReviewTestMode).toHaveBeenCalledWith({ enabled: true }))
  })

  it('普通 gate 关闭时只说明当前审批仍由用户确认', { timeout: 20000 }, async () => {
    window.api.securityReadPolicyForLane = vi.fn().mockResolvedValue({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 8,
      snapshot: { selectedPackage: 'standard', enabled: false }
    })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    expect(await within(panel).findByText(/需要人工确认的操作仍会发给你批准/)).toBeTruthy()
    expect(within(panel).queryByText(/灰度账号范围/)).toBeNull()
    expect(within(panel).queryByText(/引用\/短码匹配验证/)).toBeNull()
  })

  it('共同快照 revision 冲突时说明需刷新重试', { timeout: 20000 }, async () => {
    await changeAppLocale('en-US')
    window.api.securityWritePolicy = vi.fn().mockResolvedValue({ status: 'conflict', currentRevision: 9 })
    renderTab()
    const panel = await openLaneTab('Remote IM')
    const packageSelect = (await within(panel).findAllByRole('combobox'))[0]!
    fireEvent.mouseDown(packageSelect)
    fireEvent.click(await screen.findByText('Strict'))
    expect(await screen.findByText('The policy changed elsewhere. Refresh and try again.')).toBeTruthy()
  })

  it('渲染各区标题（策略套餐/确认记忆/安全审计）并加载模型/记忆/审计', { timeout: 20000 }, async () => {
    renderTab()
    expect(await screen.findByText('策略套餐')).toBeTruthy()
    expect(screen.getByText('确认记忆管理')).toBeTruthy()
    expect(screen.getByText('安全审计记录')).toBeTruthy()
    await waitFor(() => {
      expect(window.api.securityGetSettingsModel).toHaveBeenCalled()
      expect(window.api.securityListDecisionCache).toHaveBeenCalled()
      expect(window.api.securityQueryAudit).toHaveBeenCalled()
    })
    // 记忆条目摘要展示
    expect(await screen.findByText('git status')).toBeTruthy()
  })

  it('act 会话级信任开关渲染在确认记忆区，切换时调用 onBrowserChange', { timeout: 20000 }, async () => {
    const onBrowserChange = vi.fn()
    renderTab({ browser: { ...DEFAULT_BROWSER_CONFIG, actSessionTrustEnabled: true }, onBrowserChange })
    expect(await screen.findByText('启用 act 会话级信任')).toBeTruthy()
    const row = screen.getByText('启用 act 会话级信任').closest('.config-field')!
    const sw = row.querySelector('.ant-switch')!
    expect(sw.className).toContain('ant-switch-checked')
    fireEvent.click(sw)
    await waitFor(() => {
      expect(onBrowserChange).toHaveBeenCalledWith(
        expect.objectContaining({ actSessionTrustEnabled: false })
      )
    })
  })

  it('act 高风险关键词编辑区渲染在确认记忆区，保存时解析逗号分隔并调用 onBrowserChange', { timeout: 20000 }, async () => {
    const onBrowserChange = vi.fn()
    renderTab({ onBrowserChange })
    // 记忆区在 Collapse 中，默认未展开，先点开
    fireEvent.click(await screen.findByText('确认记忆管理'))
    const label = await screen.findByText('高风险关键词')
    const field = label.closest('.config-field')!
    // 展开编辑区
    fireEvent.click(within(field as HTMLElement).getByRole('button', { name: '点击展开详情' }))
    const textarea = within(field as HTMLElement).getByPlaceholderText('逗号分隔，如：支付, 转账, 删除')
    fireEvent.change(textarea, { target: { value: '支付, 转账, 删除' } })
    fireEvent.click(within(field as HTMLElement).getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => {
      expect(onBrowserChange).toHaveBeenCalledWith(
        expect.objectContaining({ actHighRiskKeywords: ['支付', '转账', '删除'] })
      )
    })
    // 恢复默认
    fireEvent.click(within(field as HTMLElement).getByRole('button', { name: '恢复默认' }))
    await waitFor(() => {
      expect(onBrowserChange).toHaveBeenCalledWith(
        expect.objectContaining({ actHighRiskKeywords: DEFAULT_BROWSER_CONFIG.actHighRiskKeywords })
      )
    })
  })

  it('关键词可清空为 0 个（空串不回退为旧值，保存为空列表）', { timeout: 20000 }, async () => {
    const onBrowserChange = vi.fn()
    renderTab({ onBrowserChange })
    fireEvent.click(await screen.findByText('确认记忆管理'))
    const label = await screen.findByText('高风险关键词')
    const field = label.closest('.config-field')!
    fireEvent.click(within(field as HTMLElement).getByRole('button', { name: '点击展开详情' }))
    const textarea = within(field as HTMLElement).getByPlaceholderText('逗号分隔，如：支付, 转账, 删除')
    fireEvent.change(textarea, { target: { value: '' } })
    // 清空后输入框保持为空，不得回显旧关键词
    expect((textarea as HTMLTextAreaElement).value).toBe('')
    fireEvent.click(within(field as HTMLElement).getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => {
      expect(onBrowserChange).toHaveBeenCalledWith(expect.objectContaining({ actHighRiskKeywords: [] }))
    })
  })

  it('策略套餐区只提供桌面与共享 IM 两个区域，并说明当前覆盖微信与飞书', { timeout: 20000 }, async () => {
    renderTab()
    expect(await screen.findByRole('tab', { name: '桌面' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'IM 远程' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '微信' })).toBeNull()
    expect(screen.queryByRole('tab', { name: '飞书' })).toBeNull()
    expect(screen.getByText(/现有的微信和飞书远程入口/)).toBeTruthy()
    const panel = await screen.findByRole('tabpanel')
    expect(await within(panel).findByText('script-clean-allow-desktop')).toBeTruthy()
    expect(within(panel).getByText('universal-no-lane')).toBeTruthy()
    expect(within(panel).queryByText('im-write-ask')).toBeNull()
    expect(within(panel).queryByText('remote-shell-disabled')).toBeNull()
    // 已移除独立的「链路硬约束」主开关，系统保护规则用「启用/不启用」开关
    expect(within(panel).queryByText('链路硬约束')).toBeNull()
  })

  it('分开显示 IM 能力支持渠道与当前策略许可', { timeout: 20000 }, async () => {
    const supportRules = [
      { id: 'im-low-risk-create', when: 'invocation', action: 'ask', defaultAction: 'ask', enabled: true, locked: false,
        reason: 'low risk create', overridden: false, lanes: ['wechat', 'feishu'], capabilities: ['write_file'] },
      { id: 'lark-write-ask', when: 'invocation', action: 'ask', defaultAction: 'ask', enabled: true, locked: false,
        reason: 'Feishu resource write', overridden: false, lanes: ['feishu'], capabilities: ['run_lark_cli'] }
    ] as unknown as SecuritySettingsModelPayload['rules']
    window.api.securityGetSettingsModel = vi.fn().mockResolvedValue({ ...MODEL, rules: [...MODEL.rules, ...supportRules] })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    const fileWrite = within(panel).getByTestId('im-capability-workspace.file.write')
    expect(fileWrite.textContent).toContain('本地文件写入')
    expect(fileWrite.textContent).toContain('微信、飞书')
    expect(fileWrite.textContent).toContain('策略许可: 自动审核')
    const feishuWrite = within(panel).getByTestId('im-capability-feishu.resource.write')
    expect(feishuWrite.textContent).toContain('飞书资源写入')
    expect(feishuWrite.textContent).toContain('支持渠道: 飞书')
    expect(feishuWrite.textContent).toContain('策略许可: 自动审核')
  })

  it('IM 远程 Tab 展示系统保护规则（locked）的「启用/不启用」开关，不渲染锁定标记', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await openLaneTab('IM 远程')
    expect(await within(panel).findByText('im-write-ask')).toBeTruthy()
    expect(within(panel).getByText('remote-shell-disabled')).toBeTruthy()
    // locked 系统保护规则用「启用/不启用」Switch，不再显示「锁定」标记
    expect(within(panel).queryByText('锁定')).toBeNull()
    const ruleRow = within(panel).getByText('remote-shell-disabled').closest('tr')!
    const sw = ruleRow.querySelector('.ant-switch')!
    expect(sw).toBeTruthy()
    expect(sw.className).toContain('ant-switch-checked')
    // 桌面规则不出现在微信 Tab
    expect(within(panel).queryByText('script-clean-allow-desktop')).toBeNull()
  })

  it('IM 系统保护规则开关通过共同快照禁用 locked deny', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await openLaneTab('IM 远程')
    const ruleRow = (await within(panel).findByText('remote-shell-disabled')).closest('tr')!
    const sw = ruleRow.querySelector('.ant-switch')!
    fireEvent.click(sw)
    await waitFor(() => {
      expect(window.api.securityWritePolicy).toHaveBeenCalledWith({
        lane: 'wechat', expectedRevision: 5,
        change: { kind: 'rule-enabled', ruleId: 'remote-shell-disabled', enabled: false }
      })
    })
  })

  it('切换套餐调用 securitySetPolicyPackage（standard 无二次确认）', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await screen.findByRole('tabpanel')
    const select = (await within(panel).findAllByRole('combobox'))[0]!
    fireEvent.mouseDown(select)
    fireEvent.click(await screen.findByText('严格'))
    await waitFor(() => {
      expect(window.api.securitySetPolicyPackage).toHaveBeenCalledWith({ lane: 'desktop', package: 'strict' })
    })
  })

  it('非自定义链路的规则动作不可编辑（桌面 standard 只读）', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await screen.findByRole('tabpanel')
    const row = (await within(panel).findByText('script-clean-allow-desktop')).closest('tr')!
    // 规则行内不渲染可选的动作 Select（仅纯文本），或 Select 处于禁用态
    const select = row.querySelector('.ant-select')
    if (select) expect(select.className).toContain('ant-select-disabled')
    else expect(within(row as HTMLElement).queryByRole('combobox')).toBeNull()
  })

  it('共享 IM 自定义套餐修改规则通过版本化策略快照写入', { timeout: 20000 }, async () => {
    window.api.securityGetSettingsModel = vi.fn().mockResolvedValue({
      ...MODEL,
      packages: { ...MODEL.packages, wechat: 'custom' }
    })
    window.api.securityReadPolicyForLane = vi.fn().mockResolvedValue({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 5, snapshot: { selectedPackage: 'custom' }
    })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    const ruleRow = (await within(panel).findByText('im-write-ask')).closest('tr')!
    const select = ruleRow.querySelector('.ant-select-selector')!
    fireEvent.mouseDown(select)
    const options = await screen.findAllByText(/直接执行|Execute directly/)
    fireEvent.click(options[options.length - 1]!)
    await waitFor(() => {
      expect(window.api.securityWritePolicy).toHaveBeenCalledWith({
        lane: 'wechat', expectedRevision: 5, change: { kind: 'rule-override', ruleId: 'im-write-ask', action: 'allow' }
      })
    })
  })
})

describe('生效动作与动作域（P2：显示=实际，动作域按 lane）', () => {
  it('IM 规则显示 shared resolver 的四种最终动作和各自适用能力', { timeout: 20000 }, async () => {
    const scopedRules = [
      { id: 'im-low-risk-create', when: 'invocation', action: 'ask', defaultAction: 'ask', enabled: true, locked: false,
        reason: 'low risk create', overridden: false, lanes: ['wechat', 'feishu'], capabilities: ['write_file'] },
      { id: 'im-direct-read', when: 'invocation', action: 'allow', defaultAction: 'allow', enabled: true, locked: false,
        reason: 'ordinary read', overridden: false, lanes: ['wechat', 'feishu'], capabilities: ['read_file'] },
      { id: 'im-human-confirm', when: 'invocation', action: 'confirm-every-time', defaultAction: 'confirm-every-time', enabled: true, locked: true,
        reason: 'human required', overridden: false, lanes: ['wechat', 'feishu'], capabilities: ['run_script'] }
    ] as unknown as SecuritySettingsModelPayload['rules']
    await changeAppLocale('zh-CN')
    window.api.securityGetSettingsModel = vi.fn().mockResolvedValue({ ...MODEL, rules: [...MODEL.rules, ...scopedRules] })
    window.api.securityReadPolicyForLane = vi.fn().mockResolvedValue({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 5, snapshot: { selectedPackage: 'standard' }
    })
    renderTab()
    const panel = await openLaneTab('IM 远程')
    expect(await within(panel).findByText(/禁止|Forbidden/)).toBeTruthy()
    expect((await within(panel).findAllByText(/直接执行|Execute directly/)).length).toBeGreaterThan(0)
    expect((await within(panel).findAllByText(/人工批准|Manual approval/)).length).toBeGreaterThan(0)
    const writeRow = (await within(panel).findByText('im-low-risk-create')).closest('tr')!
    expect(within(writeRow).getByText(/自动审核|Automatic review/)).toBeTruthy()
    expect(within(writeRow).getByText(/write_file/)).toBeTruthy()
  })

  it('标准套餐桌面：mcp-tool-ask 行显示「自动审核」（ask 经 effectiveActionFor 变换）且只读', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await screen.findByRole('tabpanel')
    const row = (await within(panel).findByText('mcp-tool-ask')).closest('tr')!
    expect(within(row as HTMLElement).getByText(/自动审核|Automatic review/)).toBeTruthy()
    // 非 custom 档只读：不渲染动作 Select
    expect(within(row as HTMLElement).queryByRole('combobox')).toBeNull()
  })

  it('自定义套餐桌面：动作域 4 态（含「自动审核」），选「自动审核」二次确认后写规则覆盖（B2）', { timeout: 20000 }, async () => {
    window.api.securityGetSettingsModel = vi.fn().mockResolvedValue({
      ...MODEL,
      packages: { ...MODEL.packages, desktop: 'custom' }
    })
    renderTab()
    const panel = await screen.findByRole('tabpanel')
    const row = (await within(panel).findByText('mcp-tool-ask')).closest('tr')!
    const select = within(row as HTMLElement).getByRole('combobox')
    fireEvent.mouseDown(select)
    const options = await screen.findAllByText(/自动审核|Automatic review/)
    fireEvent.click(options[options.length - 1]!)
    // 自动审核 = 开启自动审批：保留二次确认
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认开启' }))
    await waitFor(() => {
      expect(window.api.securitySetRuleOverride).toHaveBeenCalledWith({
        ruleId: 'mcp-tool-ask',
        action: 'auto-evaluator',
        lane: 'desktop'
      })
    })
  })

  it('自定义套餐桌面：shell-precheck-auto-allow 行动作域含「自动审核」（desktop availableActions）', { timeout: 20000 }, async () => {
    window.api.securityGetSettingsModel = vi.fn().mockResolvedValue({
      ...MODEL,
      packages: { ...MODEL.packages, desktop: 'custom' }
    })
    renderTab()
    const panel = await screen.findByRole('tabpanel')
    const row = (await within(panel).findByText('shell-precheck-auto-allow')).closest('tr')!
    const select = within(row as HTMLElement).getByRole('combobox')
    expect(select.closest('.ant-select')!.className).not.toContain('ant-select-disabled')
    expect(within(row as HTMLElement).getByText(/自动审核|Automatic review/)).toBeTruthy()
  })
})
