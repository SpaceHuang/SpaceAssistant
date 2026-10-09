import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { RemoteImCommonSettings } from './RemoteImCommonSettings'
import { DEFAULT_REMOTE_IM_COMMON_CONFIG } from '../../../shared/imTypes'
import configReducer from '../../store/configSlice'
import { changeAppLocale } from '../../i18n/localeSync'
import { normalizeModelEntry } from '../../../shared/llmModelConfig'
import type { ModelEntry } from '../../../shared/domainTypes'

function renderTab(props: {
  value?: typeof DEFAULT_REMOTE_IM_COMMON_CONFIG
  onChange?: (patch: Partial<typeof DEFAULT_REMOTE_IM_COMMON_CONFIG>) => void
  onAllowRemoteBrowserSessionsChange?: (enabled: boolean) => void
  models?: ModelEntry[]
  preferredLanguageModelId?: string
}) {
  const store = configureStore({ reducer: { config: configReducer } })
  const tree = (nextProps: Parameters<typeof renderTab>[0]) => (
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <RemoteImCommonSettings
            value={nextProps.value ?? DEFAULT_REMOTE_IM_COMMON_CONFIG}
            onChange={nextProps.onChange ?? vi.fn()}
            models={nextProps.models}
            preferredLanguageModelId={nextProps.preferredLanguageModelId}
            allowRemoteBrowserSessions={false}
            onAllowRemoteBrowserSessionsChange={nextProps.onAllowRemoteBrowserSessionsChange ?? vi.fn()}
          />
        </App>
      </ConfigProvider>
    </Provider>
  )
  const rendered = render(tree(props))
  return { ...rendered, store, rerenderTab: (nextProps: Parameters<typeof renderTab>[0]) => rendered.rerender(tree(nextProps)) }
}

describe('RemoteImCommonSettings', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('renders shared remote IM controls', async () => {
    renderTab({})

    expect(await screen.findByText('允许远程会话使用浏览器')).toBeTruthy()
    expect(await screen.findByText('收到远程指令时发送系统通知')).toBeTruthy()
    expect(screen.getByText(/会话续接/)).toBeTruthy()
    expect(screen.getByText('处理远程任务的大模型')).toBeTruthy()
    expect(screen.getByText('思考强度')).toBeTruthy()
    expect(screen.getByText('远程进展同步')).toBeTruthy()
    expect(screen.getByText('限制远程写入与出站')).toBeTruthy()
    expect(screen.getByText('禁止远程出站（微信发送 / 飞书写工具）')).toBeTruthy()
    expect(screen.getByText(/消息频率限制/)).toBeTruthy()
    expect(screen.getByText('已绑定发送者（只读）')).toBeTruthy()
    // P4：确认/信任管理项已迁移到「安全策略」页，此处不再展示
    expect(screen.queryByText('允许远程指令执行本地文件写操作')).toBeNull()
    expect(screen.queryByText('远程浏览器导航需确认')).toBeNull()
  })

  it('stores the selected catalog ID and exposes default inheritance and model-based effort choices', async () => {
    const onChange = vi.fn()
    const model = normalizeModelEntry({ id: 'catalog-flash', name: 'deepseek-flash' })
    const { container } = renderTab({ models: [model], preferredLanguageModelId: model.id, onChange })
    const modelField = screen.getByText('处理远程任务的大模型').closest('.config-field')!
    fireEvent.mouseDown(modelField.querySelector('.ant-select-selector')!)
    fireEvent.click(await screen.findByText('deepseek-flash'))
    expect(onChange).toHaveBeenCalledWith({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: model.id })

    const effortField = screen.getByText('思考强度').closest('.config-field')!
    fireEvent.mouseDown(effortField.querySelector('.ant-select-selector')!)
    expect((await screen.findAllByText('低')).length).toBeGreaterThan(0)
    expect(screen.getByText('最高')).toBeTruthy()
    expect(container.querySelectorAll('.ant-select').length).toBeGreaterThanOrEqual(2)
  })

  it('selecting default inheritance persists inherit mode with the current default model ID', async () => {
    const onChange = vi.fn()
    const model = normalizeModelEntry({ id: 'catalog-default', name: 'deepseek-flash' })
    renderTab({
      value: { ...DEFAULT_REMOTE_IM_COMMON_CONFIG, remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'other-model' },
      models: [model], preferredLanguageModelId: model.id, onChange
    })
    const field = screen.getByText('处理远程任务的大模型').closest('.config-field')!
    fireEvent.mouseDown(field.querySelector('.ant-select-selector')!)
    fireEvent.click(await screen.findByText(/与默认设置保持一致/))
    expect(onChange).toHaveBeenCalledWith({ remoteModelSelectionMode: 'inherit', remoteDefaultModelId: model.id })
  })

  it('refreshes model candidates and inherited label when the available model props change', async () => {
    const oldModel = normalizeModelEntry({ id: 'catalog-old', name: 'deepseek-chat' })
    const newModel = normalizeModelEntry({ id: 'catalog-new', name: 'deepseek-flash' })
    const { rerenderTab } = renderTab({ models: [oldModel], preferredLanguageModelId: oldModel.id })
    const field = screen.getByText('处理远程任务的大模型').closest('.config-field')!
    fireEvent.mouseDown(field.querySelector('.ant-select-selector')!)
    expect(await screen.findByText('deepseek-chat')).toBeTruthy()

    rerenderTab({ models: [newModel], preferredLanguageModelId: newModel.id })
    const updatedField = screen.getByText('处理远程任务的大模型').closest('.config-field')!
    fireEvent.mouseDown(updatedField.querySelector('.ant-select-selector')!)
    expect(await screen.findByText('deepseek-flash')).toBeTruthy()
    expect(screen.queryByText('deepseek-chat')).toBeNull()
  })

  it('keeps an unavailable explicit model visible and warns without selecting a replacement', async () => {
    renderTab({
      value: { ...DEFAULT_REMOTE_IM_COMMON_CONFIG, remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'removed-model' },
      models: []
    })

    expect(await screen.findByText('所选远程模型当前不可用。请恢复对应服务或重新选择模型。')).toBeTruthy()
  })

  it('calls onChange when notify checkbox is toggled', async () => {
    const onChange = vi.fn()
    renderTab({
      value: { ...DEFAULT_REMOTE_IM_COMMON_CONFIG, remoteNotifyOnReceive: true },
      onChange
    })

    fireEvent.click(await screen.findByText('收到远程指令时发送系统通知'))
    expect(onChange).toHaveBeenCalledWith({ remoteNotifyOnReceive: false })
  })

  it('calls onAllowRemoteBrowserSessionsChange when browser switch is toggled', async () => {
    const onAllowRemoteBrowserSessionsChange = vi.fn()
    renderTab({ onAllowRemoteBrowserSessionsChange })

    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[0]!)
    expect(onAllowRemoteBrowserSessionsChange).toHaveBeenCalledWith(true)
  })
})
