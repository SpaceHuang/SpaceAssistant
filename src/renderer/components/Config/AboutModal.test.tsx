import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { AboutModal } from './AboutModal'
import configReducer, { setAboutOpen } from '../../store/configSlice'
import { APP_GITHUB_URL, APP_PRODUCT_NAME, APP_VERSION } from '../../../shared/appMeta'

function renderAbout(open = true) {
  const store = configureStore({ reducer: { config: configReducer } })
  if (open) store.dispatch(setAboutOpen(true))

  window.api = {
    ...window.api,
    appOpenExternal: vi.fn().mockResolvedValue({ ok: true })
  }

  return {
    store,
    ...render(
      <Provider store={store}>
        <ConfigProvider>
          <App>
            <AboutModal />
          </App>
        </ConfigProvider>
      </Provider>
    )
  }
}

describe('AboutModal', () => {
  it('shows product identity and version when open', () => {
    renderAbout(true)
    expect(screen.getByRole('heading', { name: APP_PRODUCT_NAME })).toBeTruthy()
    expect(screen.getByText(`版本 ${APP_VERSION}`)).toBeTruthy()
    expect(screen.getByText(/本地桌面 AI 协作助手/)).toBeTruthy()
  })

  it('opens GitHub in external browser from link rows', () => {
    renderAbout(true)
    fireEvent.click(screen.getByRole('link', { name: 'GitHub 仓库' }))
    expect(window.api.appOpenExternal).toHaveBeenCalledWith(APP_GITHUB_URL)
  })

  it('closes when footer button is clicked', () => {
    const { store } = renderAbout(true)
    fireEvent.click(screen.getByRole('button', { name: /关\s*闭/ }))
    expect(store.getState().config.aboutOpen).toBe(false)
  })
})
