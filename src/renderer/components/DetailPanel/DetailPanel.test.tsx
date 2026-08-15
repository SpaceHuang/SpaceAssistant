import React from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { App } from 'antd'
import configReducer from '../../store/configSlice'
import chatReducer from '../../store/chatSlice'
import sessionReducer from '../../store/sessionSlice'
import type { Session } from '../../../shared/domainTypes'
import { DetailPanel, DetailPanelProvider, useDetailPanel } from './index'
import {
  resetFileContentSyncBusForTests,
  setFileContentMetadataGetterForTests
} from '../../services/fileContentSyncBus'

// 记录文件树挂载/卸载次数：关闭文件查看器后目录树应保持挂载，不重新初始化展开状态。
const counters = vi.hoisted(() => ({ mount: 0, unmount: 0 }))

vi.mock('../FileTree/FileTree', () => ({
  FileTree: React.forwardRef(function MockFileTree(_props, ref) {
    React.useEffect(() => {
      counters.mount += 1
      return () => {
        counters.unmount += 1
      }
    }, [])
    React.useImperativeHandle(ref, () => ({
      selectPath: vi.fn(),
      refresh: vi.fn(),
      startNewDirectory: vi.fn()
    }))
    return <div data-testid="mock-file-tree" />
  })
}))

vi.mock('./FileOverlay', () => ({
  FileOverlay: () => <div data-testid="mock-file-overlay" />
}))
vi.mock('./ReferencedFilesPanel', () => ({
  ReferencedFilesPanel: () => <div data-testid="mock-referenced-files" />
}))
vi.mock('./RemoteStatusBar', () => ({
  RemoteStatusBar: () => <div data-testid="mock-remote-status" />
}))
vi.mock('./ResizeHandle', () => ({
  ResizeHandle: () => <div data-testid="mock-resize-handle" />
}))
vi.mock('./WorkDirSelector', () => ({
  WorkDirSelector: () => <div data-testid="mock-workdir-selector" />
}))
vi.mock('../FileTree/FileTreeToolbar', () => ({
  FileTreeToolbar: () => <div data-testid="mock-file-tree-toolbar" />
}))
vi.mock('../../utils/shikiHighlighter', () => ({
  preloadShiki: vi.fn().mockResolvedValue({})
}))

function createMockApi() {
  return {
    fileReadFile: vi.fn().mockResolvedValue({ kind: 'text', content: 'hello', encoding: 'utf8' }),
    fileToViewerUrl: vi.fn().mockResolvedValue({ ok: true, url: 'file:///tmp/page.html' }),
    fileGetMetadata: vi.fn().mockResolvedValue({ mtime: 1000, size: 5, isText: true }),
    fileWatchContent: vi.fn().mockResolvedValue(undefined),
    fileOnTreeChanged: vi.fn(() => () => {}),
    fileOnContentChanged: vi.fn(() => () => {}),
    artifactList: vi.fn().mockResolvedValue([]),
    artifactOnChanged: vi.fn(() => () => undefined)
  }
}

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'metadata'>): Session {
  return {
    name: overrides.name ?? overrides.id,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    ...overrides
  }
}

let panelActions: ReturnType<typeof useDetailPanel> | null = null

function Harness() {
  panelActions = useDetailPanel()
  return <DetailPanel />
}

function renderPanel(options?: { sessions?: Session[]; currentSessionId?: string | null; artifactManagementEnabled?: boolean }) {
  const sessions = options?.sessions ?? [makeSession({ id: 's1', metadata: {} })]
  const currentSessionId = options?.currentSessionId === undefined ? 's1' : options.currentSessionId
  const store = configureStore({
    reducer: { config: configReducer, chat: chatReducer, session: sessionReducer },
    preloadedState: {
      config: {
        config: {
          workDir: '/tmp/proj',
          wiki: { enabled: false, rootPath: 'llm-wiki', hideWikiFromFileTree: false },
          activeWorkDirProfileId: '',
          workDirProfiles: [],
          artifactManagementEnabled: options?.artifactManagementEnabled ?? false
        },
        settingsOpen: false,
        aboutOpen: false
      } as never,
      chat: { currentSessionId } as never,
      session: { list: sessions, loading: false }
    }
  })
  return render(
    <Provider store={store}>
      <App>
        <DetailPanelProvider>
          <Harness />
        </DetailPanelProvider>
      </App>
    </Provider>
  )
}

describe('DetailPanel 文件树状态保留', () => {
  let originalApi: unknown

  beforeEach(() => {
    counters.mount = 0
    counters.unmount = 0
    panelActions = null
    resetFileContentSyncBusForTests()
    setFileContentMetadataGetterForTests(async () => ({ mtime: 1000, size: 5 }))
    originalApi = (window as Record<string, unknown>).api
    ;(window as Record<string, unknown>).api = createMockApi()
  })

  afterEach(() => {
    resetFileContentSyncBusForTests()
    ;(window as Record<string, unknown>).api = originalApi
    vi.clearAllMocks()
  })

  it('打开并关闭文件查看器后，文件树不重新挂载（保留目录展开状态）', async () => {
    renderPanel()

    // 初始：文件列表渲染，文件树挂载一次
    await waitFor(() => expect(counters.mount).toBe(1))
    expect(counters.unmount).toBe(0)

    // 打开文件查看器：split 通过 display:none 隐藏但保持挂载，文件树不应卸载
    await act(async () => {
      await panelActions!.openFile('src/app.ts')
    })
    expect(panelActions!.selectedFile).toBe('src/app.ts')
    expect(counters.mount).toBe(1)
    expect(counters.unmount).toBe(0)

    // 关闭查看器：split 恢复显示，文件树仍是同一实例，未发生卸载/重挂
    act(() => {
      panelActions!.closeFile()
    })
    expect(panelActions!.selectedFile).toBeNull()
    expect(counters.mount).toBe(1)
    expect(counters.unmount).toBe(0)
  })
})

describe('DetailPanel 本会话工作产物可见性', () => {
  let originalApi: unknown

  beforeEach(() => {
    panelActions = null
    resetFileContentSyncBusForTests()
    setFileContentMetadataGetterForTests(async () => ({ mtime: 1000, size: 5 }))
    originalApi = (window as Record<string, unknown>).api
    ;(window as Record<string, unknown>).api = createMockApi()
  })

  afterEach(() => {
    resetFileContentSyncBusForTests()
    ;(window as Record<string, unknown>).api = originalApi
    vi.clearAllMocks()
  })

  it('当前会话未启用工作产物管理时隐藏本会话工作产物栏', () => {
    renderPanel({
      sessions: [makeSession({ id: 's1', metadata: { artifactManagementEnabled: false } })]
    })
    expect(screen.queryByText('本会话工作产物')).toBeNull()
  })

  it('当前会话已启用工作产物管理时显示本会话工作产物栏', () => {
    renderPanel({
      sessions: [makeSession({ id: 's1', metadata: { artifactManagementEnabled: true } })],
      artifactManagementEnabled: true
    })
    expect(screen.getByText('本会话工作产物')).toBeTruthy()
  })

  it('全局关闭工作产物管理时即使会话曾启用也隐藏本会话工作产物栏', () => {
    renderPanel({
      sessions: [makeSession({ id: 's1', metadata: { artifactManagementEnabled: true } })]
    })
    expect(screen.queryByText('本会话工作产物')).toBeNull()
  })
})
