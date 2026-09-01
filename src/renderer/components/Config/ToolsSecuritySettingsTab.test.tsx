import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ToolsSecuritySettingsTab } from './ToolsSecuritySettingsTab'
import type { ToolsSettingsUi } from './ToolsSettingsTab'
import { DEFAULT_REMOTE_IM_COMMON_CONFIG } from '../../../shared/imTypes'
import configReducer from '../../store/configSlice'
import { changeAppLocale } from '../../i18n/localeSync'
import type { SecuritySettingsModelPayload } from '../../../shared/confirmation/settingsCenter'

const MODEL: SecuritySettingsModelPayload = {
  packages: { desktop: 'standard', wechat: 'custom', feishu: 'standard', automation: 'standard' },
  confirmMode: 'diff',
  deniedTools: [],
  memoryEntries: [],
  audit: { retentionDays: 180, haveAuditLog: true },
  rules: [
    {
      id: 'im-write-ask',
      when: 'invocation',
      action: 'ask',
      defaultAction: 'ask',
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
      locked: false,
      reason: '桌面 clean 脚本免确认',
      overridden: false,
      lanes: ['desktop']
    },
    {
      id: 'desktop-auto-approve',
      when: 'invocation',
      action: 'auto-evaluator',
      defaultAction: 'auto-evaluator',
      locked: false,
      reason: '桌面 confirmMode=auto 时写/编辑文件的自动审批',
      overridden: false,
      lanes: ['desktop']
    },
    {
      id: 'shell-precheck-auto-allow',
      when: 'invocation',
      action: 'auto-evaluator',
      defaultAction: 'auto-evaluator',
      locked: false,
      reason: 'shell 预检判定可跳过确认',
      overridden: false
    },
    {
      id: 'universal-no-lane',
      when: 'invocation',
      action: 'ask',
      defaultAction: 'ask',
      locked: false,
      reason: '无 lane 限定的通用规则应出现在每个链路 Tab',
      overridden: false
    }
  ]
}

const TOOL_UI: ToolsSettingsUi = {
  confirmMode: 'diff',
  deniedTools: [],
  pythonPath: 'python',
  scriptTimeout: 300,
  fileCheckpointingEnabled: true,
  maxFileSnapshots: 100,
  grepTimeoutSec: 60
}

function renderTab() {
  const store = configureStore({ reducer: { config: configReducer } })
  const setToolUi = vi.fn()
  render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <ToolsSecuritySettingsTab
            active
            toolUi={TOOL_UI}
            setToolUi={setToolUi}
            onShellEnabledChange={vi.fn()}
            remoteImValue={DEFAULT_REMOTE_IM_COMMON_CONFIG}
            onRemoteImChange={vi.fn()}
          />
        </App>
      </ConfigProvider>
    </Provider>
  )
  return { store, setToolUi }
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
      securitySetPolicyPackage: vi.fn().mockResolvedValue({ ok: true }),
      securitySetRuleOverride: vi.fn().mockResolvedValue({ ok: true }),
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

  it('渲染五区标题并加载模型/记忆/审计', { timeout: 20000 }, async () => {
    renderTab()
    expect(await screen.findByText('策略套餐')).toBeTruthy()
    expect(screen.getByText('工具开关')).toBeTruthy()
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

  it('策略套餐区按链路拆 Tab：默认桌面 Tab 只展示适用规则，无硬约束开关', { timeout: 20000 }, async () => {
    renderTab()
    // 三个链路 Tab 标题
    expect(await screen.findByRole('tab', { name: '桌面' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '微信' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '飞书' })).toBeTruthy()
    // 默认桌面 Tab：桌面规则 + 通用规则可见，远程规则不可见
    const panel = await screen.findByRole('tabpanel')
    expect(await within(panel).findByText('script-clean-allow-desktop')).toBeTruthy()
    expect(within(panel).getByText('universal-no-lane')).toBeTruthy()
    expect(within(panel).queryByText('im-write-ask')).toBeNull()
    expect(within(panel).queryByText('remote-shell-disabled')).toBeNull()
    // 桌面链路无硬约束开关（仅远程链路展示）
    expect(within(panel).queryByText('链路硬约束')).toBeNull()
  })

  it('微信 Tab 展示硬约束开关与该链路规则（含 locked 只读）', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await openLaneTab('微信')
    expect(await within(panel).findByText('链路硬约束')).toBeTruthy()
    expect(await within(panel).findByText('im-write-ask')).toBeTruthy()
    expect(within(panel).getByText('remote-shell-disabled')).toBeTruthy()
    // locked 规则不渲染可编辑 Select（展示锁定标记）
    expect(within(panel).getByText('锁定')).toBeTruthy()
    // 桌面规则不出现在微信 Tab
    expect(within(panel).queryByText('script-clean-allow-desktop')).toBeNull()
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

  it('自定义套餐链路（微信）下修改规则动作调用 securitySetRuleOverride', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await openLaneTab('微信')
    const ruleRow = (await within(panel).findByText('im-write-ask')).closest('tr')!
    const select = ruleRow.querySelector('.ant-select-selector')!
    fireEvent.mouseDown(select)
    const options = await screen.findAllByText('允许')
    fireEvent.click(options[options.length - 1]!)
    await waitFor(() => {
      expect(window.api.securitySetRuleOverride).toHaveBeenCalledWith({ ruleId: 'im-write-ask', action: 'allow' })
    })
  })
})

describe('确认模式并入规则列表（desktop-auto-approve 规则行即确认模式控件）', () => {
  it('桌面 Tab 的 desktop-auto-approve 行渲染确认模式选择器（不受套餐限制）', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await screen.findByRole('tabpanel')
    const row = (await within(panel).findByText('desktop-auto-approve')).closest('tr')!
    const select = within(row as HTMLElement).getByRole('combobox')
    // 当前值 diff → 展示文件修改内容；非自定义套餐下也可编辑
    expect(within(row as HTMLElement).getByText('展示文件修改内容')).toBeTruthy()
    expect(select.closest('.ant-select')!.className).not.toContain('ant-select-disabled')
  })

  it('切换为自动放行需二次确认，确认后写入 confirmMode=auto 草稿', { timeout: 20000 }, async () => {
    const { setToolUi } = renderTab()
    const panel = await screen.findByRole('tabpanel')
    const row = (await within(panel).findByText('desktop-auto-approve')).closest('tr')!
    fireEvent.mouseDown(within(row as HTMLElement).getByRole('combobox'))
    fireEvent.click(await screen.findByText('自动放行安全写入'))
    // 二次确认弹窗
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认开启' }))
    await waitFor(() => {
      expect(setToolUi).toHaveBeenCalled()
    })
    const updater = setToolUi.mock.calls[0]![0] as (s: { confirmMode: string }) => { confirmMode: string }
    expect(updater({ confirmMode: 'diff' })).toEqual({ confirmMode: 'auto' })
  })

  it('其余 auto-evaluator 规则（shell 预检放行）保持只读文本', { timeout: 20000 }, async () => {
    renderTab()
    const panel = await screen.findByRole('tabpanel')
    const row = (await within(panel).findByText('shell-precheck-auto-allow')).closest('tr')!
    expect(within(row as HTMLElement).queryByRole('combobox')).toBeNull()
    expect(within(row as HTMLElement).getByText('自动审批')).toBeTruthy()
  })
})
