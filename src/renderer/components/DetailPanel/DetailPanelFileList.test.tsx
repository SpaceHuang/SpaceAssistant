import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { App } from 'antd'
import configReducer from '../../store/configSlice'
import { DetailPanelFileList } from './DetailPanelFileList'
import {
  requestFilePaneSelect,
  resetFilePaneNavigationForTests
} from '../../services/filePaneNavigation'

const selectPath = vi.fn()
const refresh = vi.fn()
const startNewDirectory = vi.fn()

vi.mock('../FileTree/FileTreeToolbar', () => ({
  FileTreeToolbar: () => <div data-testid="file-tree-toolbar" />
}))

vi.mock('./WorkDirSelector', () => ({
  WorkDirSelector: () => <div data-testid="workdir-selector">Project A</div>
}))

vi.mock('../FileTree/FileTree', () => ({
  FileTree: React.forwardRef(function MockFileTree(
    { onFileSelect }: { onFileSelect?: (p: string) => void },
    ref: React.Ref<{ selectPath: typeof selectPath; refresh: typeof refresh; startNewDirectory: typeof startNewDirectory }>
  ) {
    React.useImperativeHandle(ref, () => ({
      selectPath,
      refresh,
      startNewDirectory
    }))
    return (
      <div data-testid="file-tree">
        <button type="button" onClick={() => onFileSelect?.('src/app.ts')}>
          open-file
        </button>
      </div>
    )
  })
}))

function renderList(onFileSelect = vi.fn()) {
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

  return {
    onFileSelect,
    ...render(
      <Provider store={store}>
        <App>
          <DetailPanelFileList workDir="/tmp/project" onFileSelect={onFileSelect} />
        </App>
      </Provider>
    )
  }
}

describe('DetailPanelFileList', () => {
  beforeEach(() => {
    resetFilePaneNavigationForTests()
    selectPath.mockReset()
    refresh.mockReset()
    startNewDirectory.mockReset()
  })

  it('renders file header and tree', () => {
    renderList()
    expect(screen.getByTestId('workdir-selector')).toBeDefined()
    expect(screen.getByTestId('file-tree-toolbar')).toBeDefined()
    expect(screen.getByTestId('file-tree')).toBeDefined()
  })

  it('calls onFileSelect when tree selects a file', () => {
    const onFileSelect = vi.fn()
    renderList(onFileSelect)
    screen.getByText('open-file').click()
    expect(onFileSelect).toHaveBeenCalledWith('src/app.ts')
  })

  it('selects project paths from filePaneNavigation', () => {
    renderList()
    requestFilePaneSelect({ relPath: 'README.md' })
    expect(selectPath).toHaveBeenCalledWith('README.md')
  })

  it('ignores wiki paths from filePaneNavigation', () => {
    renderList()
    requestFilePaneSelect({ relPath: 'llm-wiki/wiki/index.md', preferWiki: true })
    expect(selectPath).not.toHaveBeenCalled()
  })
})
