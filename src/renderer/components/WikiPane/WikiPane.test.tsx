import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { changeAppLocale } from '../../i18n/localeSync'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function renderWikiPane(wikiInitialized = true, apiOverride: Record<string, unknown> = {}) {
  const wikiStatus = (apiOverride.wikiStatus as ReturnType<typeof vi.fn>) ?? vi.fn().mockResolvedValue({ initialized: wikiInitialized })
  ;(window as Record<string, unknown>).api = {
    wikiStatus,
    wikiInit: vi.fn(),
    skillInvalidateCache: vi.fn(),
    fileShowInExplorer: vi.fn(),
    ...apiOverride
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

describe('WikiPane 迁移流回归（横幅 → 向导 → 报告）', () => {
  const PENDING_STATUS = {
    enabled: true,
    initialized: true,
    pendingLegacyMigration: true,
    legacyRoots: ['llm-wiki'],
    projects: []
  }

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    resetFilePaneNavigationForTests()
  })

  afterEach(() => cleanup())

  function buttonByText(text: string): HTMLElement {
    const el = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.replace(/\s/g, '') === text
    )
    if (!el) throw new Error(`button not found: ${text}`)
    return el
  }

  // antd Modal 关闭后 DOM 仍驻留（jsdom 无动效结束事件）——断言「不可见」而非「不存在」
  function expectModalClosed(titleText: string) {
    return waitFor(() => {
      const title = Array.from(document.querySelectorAll('.ant-modal-title')).find(
        (t) => t.textContent === titleText
      )
      if (!title) return
      const wrap = title.closest('.ant-modal-wrap') as HTMLElement | null
      expect(!title.isConnected || wrap?.style.display === 'none').toBe(true)
    })
  }

  it('迁移产生失败项：报告可见、关闭报告后向导不复活、横幅按真实状态保留', async () => {
    const wikiStatus = vi.fn()
      .mockResolvedValueOnce(PENDING_STATUS)
      .mockResolvedValue(PENDING_STATUS)
    const wikiMigrateLegacy = vi.fn().mockResolvedValue({
      startedAt: '2026-10-11T04:23:52.017Z',
      profiles: [{ workDir: 'F:\\新工作目录\\写作', rootDirName: 'llm-wiki', status: 'failed', error: 'ENOENT: no such file or directory, open index.md' }],
      conflicts: [],
      renames: []
    })
    renderWikiPane(true, { wikiStatus, wikiMigrateLegacy })

    expect(await screen.findByText(/检测到 1 个项目/)).toBeTruthy()
    fireEvent.click(buttonByText('迁移'))
    expect(await screen.findByText('迁移本地 Wiki 到共享记忆库')).toBeTruthy()

    fireEvent.click(buttonByText('立即迁移'))
    expect(await screen.findByText('迁移完成')).toBeTruthy()
    // 失败项不再静默
    expect(await screen.findByText(/ENOENT/)).toBeTruthy()
    expect(screen.getByText(/迁移失败项/)).toBeTruthy()

    // 关闭报告后：向导不复活；迁移确实未完成 → 横幅保留
    fireEvent.click(buttonByText('知道了'))
    await expectModalClosed('迁移本地 Wiki 到共享记忆库')
    expect(screen.queryByText(/检测到 1 个项目/)).toBeTruthy()
  })

  it('迁移成功（旧根已改名走）：状态刷新后横幅消失、报告无失败项', async () => {
    const wikiStatus = vi.fn()
      .mockResolvedValueOnce(PENDING_STATUS)
      .mockResolvedValue({ ...PENDING_STATUS, pendingLegacyMigration: false, legacyRoots: [] })
    const wikiMigrateLegacy = vi.fn().mockResolvedValue({
      startedAt: '2026-10-11T04:23:52.017Z',
      profiles: [{ workDir: 'F:\\w', rootDirName: 'llm-wiki', status: 'migrated' }],
      conflicts: [],
      renames: []
    })
    renderWikiPane(true, { wikiStatus, wikiMigrateLegacy })

    expect(await screen.findByText(/检测到 1 个项目/)).toBeTruthy()
    fireEvent.click(buttonByText('迁移'))
    expect(await screen.findByText('迁移本地 Wiki 到共享记忆库')).toBeTruthy()
    fireEvent.click(buttonByText('立即迁移'))

    expect(await screen.findByText('迁移完成')).toBeTruthy()
    expect(screen.queryByText(/迁移失败项/)).toBeNull()
    fireEvent.click(buttonByText('知道了'))
    // 迁移真实完成 → 状态刷新后横幅消失
    await expectModalClosed('迁移本地 Wiki 到共享记忆库')
    expect(screen.queryByText(/检测到 1 个项目/)).toBeNull()
  })
})
