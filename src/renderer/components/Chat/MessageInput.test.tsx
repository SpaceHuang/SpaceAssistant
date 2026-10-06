import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('./ContextUsageRing', () => ({
  ContextUsageRing: () => null
}))
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import chatReducer from '../../store/chatSlice'
import configReducer, { setConfig } from '../../store/configSlice'
import { MessageInput } from './MessageInput'
import type { AppConfig } from '../../../shared/domainTypes'
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_FEISHU_CONFIG,
  DEFAULT_SHELL_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_WIKI_CONFIG
} from '../../../shared/domainTypes'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    locale: 'zh-CN',
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: [],
    activeLlmServiceId: '',
    activeLlmServiceIds: [],
    preferredLanguageModelId: '1',
    preferredFastLanguageModelId: '',
    preferredVisionModelId: '',
    model: 'claude-sonnet-4-6',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      {
        id: '1',
        name: 'claude-sonnet-4-6',
        maximumContext: 200000,
        maxTokens: 64000,
        isDefault: false,
        isFast: false,
        isVision: false,
        enabled: true
      }
    ],
    thinkingEnabled: false,
    workDir: '',
    maxParallelChatSessions: 3,
    tools: { ...DEFAULT_TOOLS_CONFIG, enabled: false },
    skills: { ...DEFAULT_SKILLS_CONFIG },
    wiki: { ...DEFAULT_WIKI_CONFIG },
    feishu: { ...DEFAULT_FEISHU_CONFIG },
    browser: { ...DEFAULT_BROWSER_CONFIG },
    shell: { ...DEFAULT_SHELL_CONFIG },
    ...overrides
  } as AppConfig
}

function renderInput(props: Partial<React.ComponentProps<typeof MessageInput>> = {}) {
  const store = configureStore({
    reducer: { chat: chatReducer, config: configReducer }
  })
  store.dispatch(setConfig(makeConfig()))
  const onSend = vi.fn()
  return {
    store,
    onSend,
    ...render(
      <Provider store={store}>
        <MessageInput sessionId="sess-1" onSend={onSend} {...props} />
      </Provider>
    )
  }
}

describe('MessageInput', () => {
  it(
    'renders textarea and attach button',
    () => {
      const { container } = renderInput()
      expect(container.querySelector('textarea')).not.toBeNull()
      expect(container.querySelector('.composer-add-attachment')).not.toBeNull()
    },
    30_000
  )

  it('adds and revokes directory context through the composer menu', async () => {
    type Grant = { grantId: string; sessionId: string; path: string; createdAt: number; source: 'user-selected-directory'; status: 'valid' | 'invalid' }
    const api = window.api as unknown as {
      sessionDirectoryGrantsList: (sessionId: string) => Promise<Grant[]>
      sessionDirectoryGrantsAdd: (sessionId: string) => Promise<{ status: 'added'; grant: Omit<Grant, 'status'> }>
      sessionDirectoryGrantsRemove: (input: { sessionId: string; grantId: string }) => Promise<{ removed: boolean }>
    }
    const grant = { grantId: 'grant-ui-1', sessionId: 'sess-1', path: '/tmp/Project Notes', createdAt: 1, source: 'user-selected-directory' as const, status: 'valid' as const }
    let grants: Grant[] = []
    api.sessionDirectoryGrantsList = vi.fn(async () => grants)
    api.sessionDirectoryGrantsAdd = vi.fn(async () => {
      grants = [grant]
      return { status: 'added' as const, grant: { grantId: grant.grantId, sessionId: grant.sessionId, path: grant.path, createdAt: grant.createdAt, source: grant.source } }
    })
    api.sessionDirectoryGrantsRemove = vi.fn(async () => { grants = []; return { removed: true } })

    renderInput()
    fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '选择目录' }))

    expect(await screen.findByText('Project Notes')).toBeTruthy()
    expect((await screen.findByRole('status')).textContent).toContain('目录已加入当前会话')
    fireEvent.click(screen.getByRole('button', { name: '移除目录 Project Notes' }))
    expect((await screen.findByRole('status')).textContent).toContain('已移除会话目录')
    expect(api.sessionDirectoryGrantsRemove).toHaveBeenCalledWith({ sessionId: 'sess-1', grantId: 'grant-ui-1' })
    expect(screen.queryByText('Project Notes')).toBeNull()
  })

  it('disables send when text is empty', () => {
    renderInput()
    const sendBtn = screen.getByRole('button', { name: '发送消息' })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
  })

  // §5.2.1（OQ-9）：idle 态状态区整块不渲染（原「Enter 发送」提示已移除），不占位
  it('renders no composer status area while idle', () => {
    const { container } = renderInput()
    expect(container.querySelector('.composer-status')).toBeNull()
    expect(container.querySelector('.composer-hint-trigger')).toBeNull()
    expect(container.textContent).not.toContain('Enter 发送')
  })

  it('renders queued bar slot before composer box', () => {
    const { container } = renderInput({ queuedBarSlot: <div data-testid="queued-slot" /> })
    expect(container.querySelector('[data-testid="queued-slot"]')!.compareDocumentPosition(container.querySelector('.composer-box')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // §10.2 回归重点：running 态仍显示运行状态标签与耗时（§5.2.1 保留清单）
  it('still renders running status label and elapsed while running', () => {
    const { container } = renderInput({ running: true, runningStatus: '生成中', runningElapsed: '3s' })
    expect(container.querySelector('.composer-status__label')?.textContent).toBe('生成中')
    expect(container.querySelector('.composer-status__elapsed')?.textContent).toBe('3s')
  })

  // §10.2：排队提示（hintRunningQueue）保留——running + 已输入文本（canQueueSend）时显示
  it('still shows the queue hint when a send is queued while running', () => {
    const { container } = renderInput({ running: true, runningStatus: '生成中' })
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'hi' } })
    expect(container.querySelector('.composer-status__hint')?.textContent).toContain('发送并排队')
  })

  // FR1：模型与强度合并为单一 prefsSlot——slot 存在且位于状态区之前（两个 slot 已收敛为一个）
  it('places the merged prefs slot before the status area', () => {
    const { container } = renderInput({
      prefsSlot: <button type="button">deepseek-v4-pro · 中</button>,
      running: true,
      runningStatus: '生成中'
    })
    const prefsChip = screen.getByRole('button', { name: 'deepseek-v4-pro · 中' })
    const status = container.querySelector('.composer-status--running')!
    expect(prefsChip.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('MessageInput plus menu', () => {
  it('opens an accessible menu with image, directory and compaction actions in order', async () => {
    renderInput()
    fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['选择图片', '选择目录', '压缩上下文'])
    expect(items[2]?.getAttribute('aria-disabled')).toBe('false')
  })

  it('commits manual compaction and displays its marker feedback', async () => {
    const original = window.api.chatCompactSessionContext
    window.api.chatCompactSessionContext = vi.fn(async () => ({ status: 'committed' as const, compactionId: 'c1', windowId: 'w1', outputSurfaceFingerprint: 'fp1' }))
    try {
      const { container } = renderInput()
      fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: '压缩上下文' }))
      expect(await screen.findByText('上下文压缩已完成')).toBeTruthy()
      expect(window.api.chatCompactSessionContext).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }))
      expect(container.querySelector('[aria-expanded="false"]')).toBeTruthy()
    } finally {
      window.api.chatCompactSessionContext = original
    }
  })

  it.each([
    ['no-op', '当前上下文无需压缩'],
    ['uncompressible', '当前上下文无法安全压缩'],
    ['busy', '会话正在运行，请稍后再试'],
    ['failed', '上下文压缩失败，请重试']
  ] as const)('shows %s compaction feedback', async (status, expected) => {
    const original = window.api.chatCompactSessionContext
    window.api.chatCompactSessionContext = vi.fn(async () => ({ status } as { status: typeof status }))
    try {
      renderInput()
      fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: '压缩上下文' }))
      expect(await screen.findByText(expected)).toBeTruthy()
    } finally {
      window.api.chatCompactSessionContext = original
    }
  })

  it('does not project a completed compaction into a different session', async () => {
    const original = window.api.chatCompactSessionContext
    let resolveResult!: (result: { status: 'committed'; compactionId: string; windowId: string; outputSurfaceFingerprint: string }) => void
    window.api.chatCompactSessionContext = vi.fn(() => new Promise((resolve) => { resolveResult = resolve }))
    try {
      const { store, rerender, onSend } = renderInput()
      fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: '压缩上下文' }))
      await waitFor(() => expect(resolveResult).toBeTypeOf('function'))
      rerender(<Provider store={store}><MessageInput sessionId="sess-2" onSend={onSend} /></Provider>)
      await act(async () => {
        resolveResult({ status: 'committed', compactionId: 'old-session-compaction', windowId: 'w1', outputSurfaceFingerprint: 'fp1' })
      })
      expect(store.getState().chat.compactionMarkers).toEqual([])
    } finally {
      window.api.chatCompactSessionContext = original
    }
  })

  it('opens the existing file input only after choosing the image menu item', async () => {
    renderInput()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '选择图片' }))
    expect(click).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes the menu with Escape', async () => {
    renderInput()
    fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
    await screen.findByRole('menu')
    fireEvent.keyDown(screen.getByRole('menuitem', { name: '选择图片' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('adds a session directory through the main API and allows revocation', async () => {
    const grant = { grantId: 'grant-1', sessionId: 'sess-1', path: '/tmp/Project Notes', createdAt: 1, source: 'user-selected-directory' as const, status: 'valid' as const }
    let items = [grant]
    const originalList = window.api.sessionDirectoryGrantsList
    const originalAdd = window.api.sessionDirectoryGrantsAdd
    const originalRemove = window.api.sessionDirectoryGrantsRemove
    window.api.sessionDirectoryGrantsList = vi.fn(async () => items)
    window.api.sessionDirectoryGrantsAdd = vi.fn(async () => ({ status: 'added', grant }))
    window.api.sessionDirectoryGrantsRemove = vi.fn(async () => { items = []; return { removed: true } })
    try {
      renderInput()
      fireEvent.click(screen.getByRole('button', { name: '添加图片' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: '选择目录' }))
      expect(await screen.findByText('Project Notes')).toBeTruthy()
      expect((await screen.findByRole('status')).textContent).toContain('目录已加入当前会话')
      fireEvent.click(screen.getByRole('button', { name: '移除目录 Project Notes' }))
      expect((await screen.findByRole('status')).textContent).toContain('已移除会话目录')
      expect(window.api.sessionDirectoryGrantsRemove).toHaveBeenCalledWith({ sessionId: 'sess-1', grantId: 'grant-1' })
      expect(screen.queryByText('Project Notes')).toBeNull()
    } finally {
      window.api.sessionDirectoryGrantsList = originalList
      window.api.sessionDirectoryGrantsAdd = originalAdd
      window.api.sessionDirectoryGrantsRemove = originalRemove
    }
  })
})
