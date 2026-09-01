import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      overridden: false
    },
    {
      id: 'remote-shell-disabled',
      when: 'invocation',
      action: 'deny',
      defaultAction: 'deny',
      locked: true,
      reason: 'SHELL_REMOTE_DISABLED',
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
    expect(screen.getByText('确认模式')).toBeTruthy()
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
    // locked 规则不渲染可编辑 Select（仅一个可编辑动作选择器）
    expect(screen.getByText('锁定')).toBeTruthy()
  })

  it('切换套餐调用 securitySetPolicyPackage（standard 无二次确认）', { timeout: 20000 }, async () => {
    renderTab()
    const selects = await screen.findAllByRole('combobox')
    // 前三个为链路套餐选择器
    fireEvent.mouseDown(selects[0]!)
    fireEvent.click(await screen.findByText('严格'))
    await waitFor(() => {
      expect(window.api.securitySetPolicyPackage).toHaveBeenCalledWith({ lane: 'desktop', package: 'strict' })
    })
  })

  it('自定义套餐下修改规则动作调用 securitySetRuleOverride', { timeout: 20000 }, async () => {
    renderTab()
    // wechat 为 custom → 非 locked 规则动作可编辑
    const ruleRow = (await screen.findByText('im-write-ask')).closest('tr')!
    const select = ruleRow.querySelector('.ant-select-selector')!
    fireEvent.mouseDown(select)
    const options = await screen.findAllByText('允许')
    fireEvent.click(options[options.length - 1]!)
    await waitFor(() => {
      expect(window.api.securitySetRuleOverride).toHaveBeenCalledWith({ ruleId: 'im-write-ask', action: 'allow' })
    })
  })
})
