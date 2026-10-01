import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import { ChatView } from './ChatView'
import { store } from '../../store'
import { resetChatUi, setDisplayPage, setSession, patchDisplayMessage, prependDisplayPage, ackDisplayMessagePersisted, addMessage } from '../../store/chatSlice'
import { setConfig } from '../../store/configSlice'
import { setSessions } from '../../store/sessionSlice'
import type { AppConfig, Message, Session } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_BROWSER_CONFIG, DEFAULT_FEISHU_CONFIG, DEFAULT_SHELL_CONFIG, DEFAULT_SKILLS_CONFIG, DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'

vi.mock('react-virtuoso', () => {
  const ReactLocal = require('react') as typeof React
  return { Virtuoso: ReactLocal.forwardRef(function VirtuosoMock({ data, itemContent }: { data: Message[]; itemContent: (index: number, message: Message) => React.ReactNode }, ref: React.Ref<{ scrollToIndex: () => void }>) {
    ReactLocal.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }))
    return <div>{data.map((message, index) => <div key={message.id}>{itemContent(index, message)}</div>)}</div>
  }) }
})
vi.mock('@xterm/xterm', () => ({ Terminal: class { loadAddon = vi.fn(); open = vi.fn(); write = vi.fn(); clear = vi.fn(); resize = vi.fn(); dispose = vi.fn(); onScroll = vi.fn(() => ({ dispose: vi.fn() })); buffer = { active: { length: 0, baseY: 0, viewportY: 0, getLine: () => ({ translateToString: () => '' }) } } } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 })) } }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class { serialize = vi.fn(() => '') } }))
vi.mock('../DetailPanel/DetailPanelContext', () => ({ useDetailPanel: () => ({ openFile: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('../../services/chatSearchAdapter', () => ({ useChatSearchAdapter: vi.fn() }))

const session: Session = { id: 'session-a', name: 'Queued test', model: '', temperature: 0.7, maxTokens: 1000, createdAt: 1, updatedAt: 1, skillsState: { manualActivated: [], manualDisabled: [] }, metadata: {}, workDirProfileId: 'p1' }
const makeConfig = (): AppConfig => ({ locale: 'zh-CN', apiKeyPresent: true, baseUrl: '', llmServices: [], activeLlmServiceId: '', model: '', defaultModel: '', models: [], thinkingEnabled: false, workDir: '/tmp', maxParallelChatSessions: 3, tools: { ...DEFAULT_TOOLS_CONFIG, enabled: false }, skills: { ...DEFAULT_SKILLS_CONFIG }, wiki: { ...DEFAULT_WIKI_CONFIG }, feishu: { ...DEFAULT_FEISHU_CONFIG }, browser: { ...DEFAULT_BROWSER_CONFIG }, shell: { ...DEFAULT_SHELL_CONFIG }, workDirProfiles: [{ id: 'p1', name: 'Default', path: '/tmp', isDefault: true }], activeWorkDirProfileId: 'p1' } as AppConfig)
const msg = (id: string, content: string, status: Message['status'] = 'queued'): Message => ({ id, sessionId: session.id, role: 'user', content, timestamp: 1, status, schemaVersion: CURRENT_SCHEMA_VERSION })
function setupApi(entries: Message[] = [msg('q1', 'first'), msg('q2', 'second'), msg('normal', 'visible', 'sent')]) {
  Object.assign(window.api, { chatGetMessagePage: vi.fn().mockResolvedValue({ entries: entries.map((message, sequence) => ({ message, sequence })), oldestSequence: 0, hasMoreBefore: false }), chatGetApiContextBaseline: vi.fn().mockResolvedValue({ sessionId: session.id, entries: [] }), chatGetContextHistorySummaryBaseline: vi.fn().mockResolvedValue({ sessionId: session.id, entries: [] }), chatGetSearchCorpusPage: vi.fn().mockResolvedValue({ entries: entries.map((message, sequence) => ({ message, sequence })), nextSequence: entries.length, hasMore: false }), chatGetTurnErrors: vi.fn().mockResolvedValue([]), chatGetMessageSequence: vi.fn().mockResolvedValue(null), chatGetNextQueuedMessage: vi.fn().mockResolvedValue(null), chatResolveRetryContext: vi.fn().mockResolvedValue(null), chatDeleteQueuedMessage: vi.fn().mockResolvedValue({ ok: true, sessionId: session.id }), messageAppendNonTurn: vi.fn().mockResolvedValue(null), messagePatchNonTurn: vi.fn().mockResolvedValue(null), chatUpdateQueuedMessage: vi.fn().mockResolvedValue({ ok: true, message: msg('q1', 'saved'), sequence: 0 }), chatReorderQueuedMessages: vi.fn().mockResolvedValue({ ok: true, entries: [{ message: msg('q2', 'second'), sequence: 0 }, { message: msg('q1', 'first'), sequence: 1 }] }), sessionGet: vi.fn().mockResolvedValue(session), sessionBackfillAutoTitleIfNeeded: vi.fn().mockResolvedValue(null), feishuOnInboundMessage: vi.fn().mockReturnValue(() => {}), skillRoute: vi.fn().mockResolvedValue({ skills: [], meta: { sources: {}, llmRecommended: false, routingFailed: false } }), wikiGetSchema: vi.fn().mockResolvedValue(null), usageGet: vi.fn().mockResolvedValue(undefined), usageSet: vi.fn().mockResolvedValue(undefined), usageDelete: vi.fn().mockResolvedValue(undefined), workdirSwitch: vi.fn().mockResolvedValue({ success: true, sessions: [] }), configGet: vi.fn().mockResolvedValue(makeConfig()) })
}
function renderView() { return render(<Provider store={store}><ConfigProvider><App><ChatView /></App></ConfigProvider></Provider>) }

describe('ChatView queuedBar', () => {
  beforeEach(async () => { vi.clearAllMocks(); await changeAppLocale('zh-CN'); store.dispatch(resetChatUi()); store.dispatch(setConfig(makeConfig())); store.dispatch(setSession(session.id)); store.dispatch(setSessions([session])); setupApi() })
  it('列表排除排队气泡但输入框上方渲染横条', async () => { const { container } = renderView(); await screen.findByText('first'); expect(container.querySelectorAll('[data-message-id="q1"], [data-message-id="q2"]')).toHaveLength(0); expect(container.querySelector('[data-message-id="normal"]')).toBeTruthy(); expect(container.querySelectorAll('.queued-task-bar__summary')).toHaveLength(2) })
  it('横条 DOM 位于 composer-box 之前', async () => { const { container } = renderView(); await screen.findByText('first'); expect(container.querySelector('.queued-task-bar')!.compareDocumentPosition(container.querySelector('.composer-box')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy() })
  it('拖动队列项后持久化并按新顺序显示', async () => {
    const { container } = renderView()
    await screen.findByText('first')
    const handles = container.querySelectorAll('.queued-task-bar__drag-handle')
    const rows = container.querySelectorAll('.queued-task-bar__row')
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => 'q2'), effectAllowed: 'none' }
    fireEvent.dragStart(handles[1]!, { dataTransfer })
    fireEvent.drop(rows[0]!, { dataTransfer })
    await waitFor(() => expect(window.api.chatReorderQueuedMessages).toHaveBeenCalledWith({ sessionId: session.id, messageIds: ['q2', 'q1'] }))
    await waitFor(() => expect([...container.querySelectorAll('.queued-task-bar__summary')].map((node) => node.textContent)).toEqual(['second', 'first']))
  })
  it('编辑提交调用编辑 IPC 并退出编辑态', async () => { const { container } = renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); const editor = screen.getByRole('textbox', { name: '编辑排队消息：first' }); fireEvent.change(editor, { target: { value: 'changed' } }); fireEvent.click(container.querySelector('.queued-task-bar__save')!); await waitFor(() => expect(window.api.chatUpdateQueuedMessage).toHaveBeenCalledWith({ sessionId: session.id, messageId: 'q1', content: 'changed' })); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()) })
  it.each([{ name: '成功', result: { ok: true, message: msg('q1', 'saved'), sequence: 0 } }, { name: '失败', result: { ok: false, error: 'message_not_queued' } }])('会话 A 的迟到$name响应不清除会话 B 草稿或阻止其保存', async ({ result }) => {
    setupApi([msg('q1', 'first')])
    let resolveEdit!: (value: typeof result) => void
    vi.mocked(window.api.chatUpdateQueuedMessage).mockImplementationOnce(() => new Promise((resolve) => { resolveEdit = resolve }) as never)
    const { container } = renderView()
    await screen.findByText('first')
    fireEvent.click(screen.getByLabelText('编辑排队消息：first'))
    fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { target: { value: 'A changed' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { key: 'Enter' })
    await waitFor(() => expect(window.api.chatUpdateQueuedMessage).toHaveBeenCalledTimes(1))
    const bMessage = { ...msg('b-q1', 'B first'), sessionId: 'session-b' }
    vi.mocked(window.api.chatGetMessagePage).mockResolvedValueOnce({ entries: [{ message: bMessage, sequence: 0 }], oldestSequence: 0, hasMoreBefore: false })
    act(() => store.dispatch(setSessions([{ ...session, id: 'session-b', name: 'B' }, session])))
    act(() => store.dispatch(setSession('session-b')))
    // 更新 B 的加载响应后，进入编辑并输入尚未保存的草稿。
    await waitFor(() => expect(window.api.chatGetMessagePage).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-b' })))
    const bEdit = await screen.findByLabelText('编辑排队消息：B first')
    fireEvent.click(bEdit)
    fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：B first' }), { target: { value: 'B draft' } })
    await act(async () => { resolveEdit(result); await Promise.resolve() })
    const bEditor = await screen.findByRole('textbox', { name: '编辑排队消息：B first' }) as HTMLTextAreaElement
    expect(bEditor.value).toBe('B draft')
    expect((container.querySelector('.queued-task-bar__save') as HTMLButtonElement).disabled).toBe(false)
  })
  it.each([{ name: '成功', result: { ok: true, message: msg('q1', 'saved'), sequence: 0 } }, { name: '失败', result: { ok: false, error: 'message_not_queued' } }])('同一消息重新编辑后，旧请求的迟到$name响应不会清除新草稿', async ({ result }) => {
    setupApi([msg('q1', 'first')])
    let resolveEdit!: (value: typeof result) => void
    vi.mocked(window.api.chatUpdateQueuedMessage).mockImplementationOnce(() => new Promise((resolve) => { resolveEdit = resolve }) as never)
    const { container } = renderView()
    await screen.findByText('first')
    fireEvent.click(screen.getByLabelText('编辑排队消息：first'))
    fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { target: { value: 'first attempt' } })
    fireEvent.click(container.querySelector('.queued-task-bar__save')!)
    await waitFor(() => expect(window.api.chatUpdateQueuedMessage).toHaveBeenCalledTimes(1))
    fireEvent.click(container.querySelector('.queued-task-bar__discard')!)
    fireEvent.click(screen.getByLabelText('编辑排队消息：first'))
    const editor = screen.getByRole('textbox', { name: '编辑排队消息：first' })
    fireEvent.change(editor, { target: { value: 'new unsaved draft' } })
    expect((container.querySelector('.queued-task-bar__save') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { resolveEdit(result); await Promise.resolve() })
    const currentEditor = container.querySelector('.queued-task-bar__editor textarea') as HTMLTextAreaElement
    expect(currentEditor.value).toBe('new unsaved draft')
    expect((container.querySelector('.queued-task-bar__save') as HTMLButtonElement).disabled).toBe(false)
  })
  it('空白草稿按 Enter 时不调用编辑 IPC', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); const editor = screen.getByRole('textbox', { name: '编辑排队消息：first' }); fireEvent.change(editor, { target: { value: '   ' } }); fireEvent.keyDown(editor, { key: 'Enter' }); expect(window.api.chatUpdateQueuedMessage).not.toHaveBeenCalled(); expect(screen.getByRole('textbox', { name: '编辑排队消息：first' })).toBeTruthy() })
  it('进入编辑时草稿为当前正文，点击同一编辑器不覆盖草稿', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); const editor = screen.getByRole('textbox', { name: '编辑排队消息：first' }) as HTMLTextAreaElement; expect(editor.value).toBe('first'); fireEvent.change(editor, { target: { value: 'unsaved' } }); fireEvent.click(editor); expect((screen.getByRole('textbox', { name: '编辑排队消息：first' }) as HTMLTextAreaElement).value).toBe('unsaved') })
  it('无未保存改动时可切换另一排队项', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.click(screen.getByLabelText('编辑排队消息：second')); expect(screen.getByRole('textbox', { name: '编辑排队消息：second' })).toBeTruthy() })
  it('有未保存改动时阻止切换并保留当前草稿', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { target: { value: 'unsaved' } }); fireEvent.click(screen.getByLabelText('编辑排队消息：second')); expect(screen.queryByRole('textbox', { name: '编辑排队消息：second' })).toBeNull(); expect((screen.getByRole('textbox', { name: '编辑排队消息：first' }) as HTMLTextAreaElement).value).toBe('unsaved') })
  it('未修改正文时提交不调用 IPC', async () => { const { container } = renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.click(container.querySelector('.queued-task-bar__save')!); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()); expect(window.api.chatUpdateQueuedMessage).not.toHaveBeenCalled() })
  it('保存失败保留草稿并允许重试', async () => { const { container } = renderView(); await screen.findByText('first'); vi.mocked(window.api.chatUpdateQueuedMessage).mockRejectedValueOnce(new Error('temporary failure')); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { target: { value: 'retry text' } }); fireEvent.click(container.querySelector('.queued-task-bar__save')!); await waitFor(() => expect((screen.getByRole('textbox', { name: '编辑排队消息：first' }) as HTMLTextAreaElement).value).toBe('retry text')); fireEvent.click(container.querySelector('.queued-task-bar__save')!); await waitFor(() => expect(window.api.chatUpdateQueuedMessage).toHaveBeenCalledTimes(2)); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()) })
  it('点击编辑中的排队项取消时调用删除通道', async () => { const { container } = renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.click(container.querySelector('.queued-task-bar__cancel')!); await waitFor(() => expect(window.api.chatDeleteQueuedMessage).toHaveBeenCalledWith({ sessionId: session.id, messageId: 'q1' })) })
  it('编辑状态下正常 patch 保留草稿，display generation 换代时关闭', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); const editor = screen.getByRole('textbox', { name: '编辑排队消息：first' }); fireEvent.change(editor, { target: { value: 'draft' } }); act(() => { store.dispatch(patchDisplayMessage({ id: 'q1', patch: { timestamp: 2 } })) }); await waitFor(() => expect((screen.getByRole('textbox', { name: '编辑排队消息：first' }) as HTMLTextAreaElement).value).toBe('draft')); act(() => { store.dispatch(setDisplayPage({ entries: [{ message: msg('q1', 'first'), sequence: 0 }], oldestSequence: 0, hasMoreBefore: false, generation: 99 })) }); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()) })
  it('ack 与向前分页更新保留编辑草稿', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { target: { value: 'draft' } }); act(() => { store.dispatch(addMessage(msg('new-message', 'new', 'sent'))); store.dispatch(ackDisplayMessagePersisted({ messageId: 'new-message', sequence: 10 })); const generation = store.getState().chat.displayGeneration; store.dispatch(prependDisplayPage({ entries: [{ message: msg('older', 'older', 'sent'), sequence: -1 }], oldestSequence: -1, hasMoreBefore: false, generation })) }); await waitFor(() => expect((screen.getByRole('textbox', { name: '编辑排队消息：first' }) as HTMLTextAreaElement).value).toBe('draft')) })
  it('切换会话清空编辑草稿', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { target: { value: 'draft' } }); act(() => { store.dispatch(setSession('session-b')) }); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()) })
  it('取消正在编辑的最后一项后焦点回到 composer', async () => { setupApi([msg('q1', 'first')]); store.dispatch(resetChatUi()); store.dispatch(setSession(session.id)); const { container } = renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.click(container.querySelector('.queued-task-bar__cancel')!); await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.composer-box textarea'))) })
  it('排队项转正后回到消息列表并从横条移除', async () => { const { container } = renderView(); await screen.findByText('first'); act(() => { store.dispatch(patchDisplayMessage({ id: 'q1', patch: { status: 'sent' } })) }); await waitFor(() => expect(container.querySelector('[data-message-id="q1"]')).toBeTruthy()); expect(container.querySelectorAll('.queued-task-bar__row')).toHaveLength(1) })
  it('目标被执行时提示并关闭编辑态', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); act(() => { store.dispatch(patchDisplayMessage({ id: 'q1', patch: { status: 'sent' } })) }); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()); await waitFor(() => expect(document.querySelector('.ant-message-notice-content')?.textContent).toContain('已开始执行')) })
  it('目标被删除时静默关闭编辑态', async () => { renderView(); await screen.findByText('first'); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); act(() => { store.dispatch(setDisplayPage({ entries: [{ message: msg('q2', 'second'), sequence: 1 }], oldestSequence: 1, hasMoreBefore: false, generation: store.getState().chat.displayGeneration })) }); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()); expect(document.querySelector('.ant-message-notice-content')?.textContent ?? '').not.toContain('已开始执行') })
  it('编辑保存遇到 message_not_queued 时提示并关闭编辑态', async () => { const { container } = renderView(); await screen.findByText('first'); vi.mocked(window.api.chatUpdateQueuedMessage).mockResolvedValueOnce({ ok: false, error: 'message_not_queued' }); fireEvent.click(screen.getByLabelText('编辑排队消息：first')); fireEvent.change(screen.getByRole('textbox', { name: '编辑排队消息：first' }), { target: { value: 'changed' } }); fireEvent.click(container.querySelector('.queued-task-bar__save')!); await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑排队消息：first' })).toBeNull()); await waitFor(() => expect(document.querySelector('.ant-message-notice-content')?.textContent).toContain('已开始执行')) })
})
