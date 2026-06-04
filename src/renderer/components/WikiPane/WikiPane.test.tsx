import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { changeAppLocale } from '../../i18n/localeSync'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { App } from 'antd'
import configReducer from '../../store/configSlice'
import { WikiPane } from './WikiPane'
import {
  requestFilePaneSelect,
  resetFilePaneNavigationForTests
} from '../../services/filePaneNavigation'

const selectPath = vi.fn()
const refresh = vi.fn()
const startNewDirectory = vi.fn()

vi.mock('../FileTree/FileTree', () => ({
  FileTree: React.forwardRef(function MockFileTree(
    _props: unknown,
    ref: React.Ref<{ selectPath: typeof selectPath; refresh: typeof refresh; startNewDirectory: typeof startNewDirectory }>
  ) {
    React.useImperativeHandle(ref, () => ({
      selectPath,
      refresh,
      startNewDirectory
    }))
    return <div data-testid="wiki-tree" />
  })
}))

function renderWikiPane(wikiInitialized = true) {
  const wikiStatus = vi.fn().mockResolvedValue({ initialized: wikiInitialized })
  ;(window as Record<string, unknown>).api = {
    wikiStatus,
    wikiInit: vi.fn(),
    skillInvalidateCache: vi.fn(),
    fileShowInExplorer: vi.fn()
  }

  const onSwitchToWikiTab = vi.fn()
  const onFileSelect = vi.fn()

  const store = configureStore({
    reducer: { config: configReducer },
    preloadedState: {
      config: {
        config: {
          workDir: '/tmp/project',
          wiki: { enabled: true, rootPath: 'llm-wiki', hideWikiFromFileTree: true }
        },
        settingsOpen: false,
        aboutOpen: false
      }
    } as never
  })

  const view = render(
    <Provider store={store}>
      <App>
        <WikiPane
          workDir="/tmp/project"
          onFileSelect={onFileSelect}
          onSwitchToWikiTab={onSwitchToWikiTab}
        />
      </App>
    </Provider>
  )

  return { onSwitchToWikiTab, onFileSelect, wikiStatus, ...view }
}

describe('WikiPane', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    resetFilePaneNavigationForTests()
    selectPath.mockReset()
  })

  it('shows init placeholder when wiki is not initialized (zh-CN)', async () => {
    renderWikiPane(false)
    await waitFor(() => {
      expect(screen.getByText('Wiki 尚未初始化')).toBeDefined()
    })
    expect(screen.getByRole('button', { name: '初始化 Wiki' })).toBeDefined()
  })

  it('shows init placeholder in English (en-US)', async () => {
    await changeAppLocale('en-US')
    renderWikiPane(false)
    await waitFor(() => {
      expect(screen.getByText('Wiki not initialized')).toBeDefined()
    })
    expect(screen.getByRole('button', { name: 'Initialize Wiki' })).toBeDefined()
  })

  it('renders wiki tree when initialized', async () => {
    renderWikiPane(true)
    await waitFor(() => {
      expect(screen.getByTestId('wiki-tree')).toBeDefined()
    })
    expect(screen.getByText('Wiki')).toBeDefined()
    expect(screen.getByTestId('wiki-open-btn')).toBeDefined()
    expect(screen.getByTestId('wiki-refresh-btn')).toBeDefined()
  })

  it('switches wiki tab and selects wiki paths from navigation', async () => {
    const { onSwitchToWikiTab } = renderWikiPane(true)
    await waitFor(() => {
      expect(screen.getByTestId('wiki-tree')).toBeDefined()
    })

    requestFilePaneSelect({ relPath: 'llm-wiki/wiki/index.md', preferWiki: true })
    expect(onSwitchToWikiTab).toHaveBeenCalled()
    expect(selectPath).toHaveBeenCalledWith('llm-wiki/wiki/index.md')
  })
})
