import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { SecuritySettingsTab } from './ToolsSecuritySettingsTab'
import configReducer from '../../store/configSlice'
import { changeAppLocale } from '../../i18n/localeSync'
import type { SecuritySettingsModelPayload } from '../../../shared/confirmation/settingsCenter'
import { DEFAULT_BROWSER_CONFIG } from '../../../shared/domainTypes'
import { DEFAULT_POLICY_RULES } from '../../../shared/policy/defaultRules'
import { LANE_PROFILES } from '../../../shared/policy/policyPackages'

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
          <SecuritySettingsTab
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
  await waitFor(() => expect(screen.getAllByRole('tabpanel').some((panel) => panel.getAttribute('aria-hidden') === 'false')).toBe(true))
  return screen.getAllByRole('tabpanel').find((panel) => panel.getAttribute('aria-hidden') === 'false')!
}


beforeEach(async()=>{
 await changeAppLocale('zh-CN')
 window.api={...window.api,securityGetSettingsModel:vi.fn().mockResolvedValue(MODEL),securityReadPolicyForLane:vi.fn().mockResolvedValue({domain:'im',policyBehaviorVersion:'im-v1.6',revision:5,snapshot:{selectedPackage:'custom',ruleOverrides:{'mcp-tool-ask':'deny'}}}),securityListDecisionCache:vi.fn().mockResolvedValue([]),securityQueryAudit:vi.fn().mockResolvedValue([]),securityGetAuditRetention:vi.fn().mockResolvedValue(180)} as typeof window.api
})
it('IM-only override offers reset without requiring a desktop override',async()=>{
 renderTab(); const panel=await openLaneTab('IM 远程')
 const row=(await within(panel).findByText('mcp-tool-ask')).closest('tr')!
 await waitFor(()=>expect(within(row).getByRole('combobox').closest('.ant-select')?.textContent).toContain('禁止'))
 expect(within(row).queryByRole('button',{name:'恢复默认'})).not.toBeNull()
})
it('desktop override never changes an unconfigured IM rule display',async()=>{
 window.api.securityGetSettingsModel=vi.fn().mockResolvedValue({...MODEL,rules:MODEL.rules.map(r=>r.id==='mcp-tool-ask'?{...r,action:'deny',overridden:true}:r)})
 window.api.securityReadPolicyForLane=vi.fn().mockResolvedValue({domain:'im',policyBehaviorVersion:'im-v1.6',revision:5,snapshot:{selectedPackage:'custom',ruleOverrides:{}}})
 renderTab();const panel=await openLaneTab('IM 远程');const row=(await within(panel).findByText('mcp-tool-ask')).closest('tr')!
 await waitFor(()=>expect(within(row).getByRole('combobox').closest('.ant-select')?.textContent).toContain('人工批准'))
})
