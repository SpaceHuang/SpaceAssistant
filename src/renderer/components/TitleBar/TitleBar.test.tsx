import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { TitleBar } from './TitleBar'
import configReducer from '../../store/configSlice'
import '../../i18n'

describe('TitleBar 查看菜单', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      windowGetPlatform: async () => 'win32',
      windowIsMaximized: async () => false,
      windowOnMaximizeChanged: () => () => undefined,
      appToggleDevTools: vi.fn()
    }
  })

  function renderTitleBar() {
    const store = configureStore({ reducer: { config: configReducer } })
    render(
      <Provider store={store}>
        <ConfigProvider>
          <TitleBar />
        </ConfigProvider>
      </Provider>
    )
    return store
  }

  it('查看菜单包含「Token 用量统计」入口，点击后打开统计面板', async () => {
    const store = renderTitleBar()

    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    const menuItem = await screen.findByText('Token 用量统计')
    expect(menuItem).toBeTruthy()

    fireEvent.click(menuItem)
    await waitFor(() => {
      expect(store.getState().config.usageStatsOpen).toBe(true)
    })
  })
})
