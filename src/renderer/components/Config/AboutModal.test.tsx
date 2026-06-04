import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { AboutModal } from './AboutModal'
import configReducer, { setAboutOpen } from '../../store/configSlice'
import { APP_GITHUB_URL, APP_PRODUCT_NAME, APP_VERSION } from '../../../shared/appMeta'
import { changeAppLocale } from '../../i18n/localeSync'

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
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('shows product identity and version when open (zh-CN)', async () => {
    renderAbout(true)
    expect(screen.getByRole('heading', { name: APP_PRODUCT_NAME })).toBeTruthy()
    expect(screen.getByText(`版本 ${APP_VERSION}`)).toBeTruthy()
    expect(screen.getByText(/AI 驱动的桌面助手/)).toBeTruthy()
  })

  it('shows product identity and version when open (en-US)', async () => {
    await changeAppLocale('en-US')
    renderAbout(true)
    expect(screen.getByRole('heading', { name: APP_PRODUCT_NAME })).toBeTruthy()
    expect(screen.getByText(`Version ${APP_VERSION}`)).toBeTruthy()
    expect(screen.getByText(/AI-powered desktop assistant/)).toBeTruthy()
  })

  it('opens GitHub in external browser from link rows (zh-CN)', () => {
    renderAbout(true)
    fireEvent.click(screen.getByRole('link', { name: 'GitHub 仓库' }))
    expect(window.api.appOpenExternal).toHaveBeenCalledWith(APP_GITHUB_URL)
  })

  it('opens GitHub in external browser from link rows (en-US)', async () => {
    await changeAppLocale('en-US')
    renderAbout(true)
    fireEvent.click(screen.getByRole('link', { name: 'GitHub repository' }))
    expect(window.api.appOpenExternal).toHaveBeenCalledWith(APP_GITHUB_URL)
  })

  it('closes when footer button is clicked (zh-CN)', () => {
    const { store } = renderAbout(true)
    const footer = document.querySelector('.about-modal__footer')!
    fireEvent.click(within(footer).getByRole('button', { name: /关\s*闭/ }))
    expect(store.getState().config.aboutOpen).toBe(false)
  })

  it('closes when footer button is clicked (en-US)', async () => {
    await changeAppLocale('en-US')
    const { store } = renderAbout(true)
    const footer = document.querySelector('.about-modal__footer')!
    fireEvent.click(within(footer).getByRole('button', { name: 'Close' }))
    expect(store.getState().config.aboutOpen).toBe(false)
  })
})
