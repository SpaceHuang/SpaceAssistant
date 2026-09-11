import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import type { AppConfig, ModelEntry } from '../../../shared/domainTypes'
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_FEISHU_CONFIG,
  DEFAULT_SHELL_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_WECHAT_CONFIG,
  DEFAULT_WIKI_CONFIG
} from '../../../shared/domainTypes'
import { store } from '../../store'
import { setConfig, setSettingsActiveTab, setSettingsOpen } from '../../store/configSlice'
import { ConfigSettingsPage } from './ConfigModal'

/** 场景取自真实配置：DeepSeek 官方服务同时支持 deepseek-v4-pro（普通）与 deepseek-flash（快速） */
const models: ModelEntry[] = [
  {
    id: '4',
    name: 'deepseek-v4-pro',
    maximumContext: 1_048_565,
    maxTokens: 384000,
    isDefault: false,
    isFast: false,
    isVision: false,
    enabled: true
  },
  {
    id: '5',
    name: 'deepseek-flash',
    maximumContext: 1_048_565,
    maxTokens: 384000,
    isDefault: false,
    isFast: true,
    isVision: false,
    enabled: true
  }
]

const cfg = {
  locale: 'zh-CN',
  thinkingEnabled: false,
  models,
  llmServices: [
    {
      id: 'ds',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKeyPresent: true,
      supportedModelIds: ['4', '5']
    }
  ],
  activeLlmServiceId: 'ds',
  activeLlmServiceIds: ['ds'],
  model: 'deepseek-v4-pro',
  defaultModel: 'deepseek-v4-pro',
  preferredLanguageModelId: '4',
  preferredFastLanguageModelId: '5',
  preferredVisionModelId: '',
  apiKeyPresent: true,
  baseUrl: 'https://api.deepseek.com/anthropic',
  workDir: 'C:\\SpaceAssistant-Work',
  workDirProfiles: [{ id: 'd1', name: '工作目录', path: 'C:\\SpaceAssistant-Work', isDefault: true }],
  activeWorkDirProfileId: 'd1',
  maxParallelChatSessions: 3,
  tools: { ...DEFAULT_TOOLS_CONFIG },
  skills: { ...DEFAULT_SKILLS_CONFIG },
  wiki: { ...DEFAULT_WIKI_CONFIG },
  feishu: { ...DEFAULT_FEISHU_CONFIG },
  wechat: { ...DEFAULT_WECHAT_CONFIG },
  browser: { ...DEFAULT_BROWSER_CONFIG },
  shell: { ...DEFAULT_SHELL_CONFIG }
} as unknown as AppConfig

function renderPage() {
  return render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <ConfigSettingsPage />
        </App>
      </ConfigProvider>
    </Provider>
  )
}

/** 「语言模型」分组下的「默认」下拉 */
function languageDefaultField(container: HTMLElement): HTMLElement {
  const fields = Array.from(container.querySelectorAll<HTMLElement>('.config-models-preferred-field'))
  const field = fields.find(
    (f) => f.querySelector('.config-models-preferred-field__label')?.textContent === '默认'
  )
  if (!field) throw new Error('未找到「语言模型 → 默认」下拉')
  return field
}

function dropdownOption(text: string): HTMLElement {
  const options = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option-content'))
  const hit = options.find((o) => o.textContent?.includes(text))
  if (!hit) throw new Error(`下拉中未找到 ${text}`)
  return hit
}

describe('ConfigSettingsPage 优选默认模型', () => {
  let configSet: ReturnType<typeof vi.fn>

  beforeEach(() => {
    configSet = vi.fn(async () => undefined)
    const api = window.api as unknown as Record<string, unknown>
    api.configGet = vi.fn(async () => cfg)
    api.configSet = configSet
    api.workdirCheckWritable = vi.fn(async () => ({ ok: true }))
    api.windowGetPlatform = vi.fn(async () => 'win32')
    api.llmFetchServiceModels = vi.fn(async () => ({ ok: false, error: 'network' }))
    store.dispatch(setConfig(cfg))
    store.dispatch(setSettingsActiveTab('models'))
    store.dispatch(setSettingsOpen(true))
  })

  it('「语言模型 → 默认」可改选快速模型并保存生效', async () => {
    const { container } = renderPage()
    const saveBtn = screen.getByRole('button', { name: '保存并返回' })

    // 等待基线快照建立（组件在 setTimeout(0) 内写入 baselineRef）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const field = languageDefaultField(container)
    expect(saveBtn.disabled).toBe(true)

    fireEvent.mouseDown(field.querySelector('input')!)
    await waitFor(() => dropdownOption('deepseek-flash'))
    fireEvent.click(dropdownOption('deepseek-flash'))

    // 关键回归：改动优选默认模型后必须被视为「有未保存更改」，否则无法保存
    await waitFor(() => expect(saveBtn.disabled).toBe(false))

    fireEvent.click(saveBtn)
    await waitFor(() => expect(configSet).toHaveBeenCalled())
    const calls = configSet.mock.calls as unknown as Array<[Record<string, unknown>]>
    expect(calls[calls.length - 1]![0]).toMatchObject({
      preferredLanguageModelId: '5',
      preferredFastLanguageModelId: '5'
    })
  })
})
