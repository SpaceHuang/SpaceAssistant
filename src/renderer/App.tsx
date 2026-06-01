import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Empty, Input } from 'antd'
import { Square, Trash2 } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from './hooks'
import { setSessions, upsertSession, removeSession } from './store/sessionSlice'
import { setSession, setScrollToMessageId } from './store/chatSlice'
import { setConfig, setSettingsOpen, setAboutOpen } from './store/configSlice'
import { ChatView } from './components/Chat/ChatView'
import { ConfigSettingsPage } from './components/Config/ConfigModal'
import { AboutModal } from './components/Config/AboutModal'
import { WikiPane } from './components/WikiPane'
import { collectToWiki } from './services/wikiImportService'
import { DetailPanel, DetailPanelProvider, useDetailPanel } from './components/DetailPanel'
import { SplitPane } from './components/ui/SplitPane'
import { groupSessionsByTime } from './utils/groupSessions'
import { abortSessionRun } from './services/chatRunnerService'
import { initFeishuRemoteStreamBridge } from './services/feishuRemoteStreamService'
import { SessionListIcon } from './components/SessionList/SessionListIcon'
import { PendingConfirmBanner } from './components/SessionList/PendingConfirmBanner'
import { SearchPane } from './components/Search/SearchPane'
import { requestFilePaneSelect, isUnderWikiRoot } from './services/filePaneNavigation'
import { DEFAULT_WIKI_CONFIG } from '../shared/domainTypes'
import chatLineRaw from './assets/chat_3_line.svg?raw'
import chatFillRaw from './assets/chat_3_fill.svg?raw'
import wikiLineRaw from './assets/book_2_ai_line.svg?raw'
import wikiFillRaw from './assets/book_2_ai_fill.svg?raw'
import searchLineRaw from './assets/search_line.svg?raw'
import searchFillRaw from './assets/search_fill.svg?raw'
import settingsRaw from './assets/settings_1_line.svg?raw'

const patchSvg = (raw: string) => raw.replace(/fill="#09244[bB]"/g, 'fill="currentColor"')

const chatLineSvg = patchSvg(chatLineRaw)
const chatFillSvg = patchSvg(chatFillRaw)
const wikiLineSvg = patchSvg(wikiLineRaw)
const wikiFillSvg = patchSvg(wikiFillRaw)
const searchLineSvg = patchSvg(searchLineRaw)
const searchFillSvg = patchSvg(searchFillRaw)
const settingsSvg = patchSvg(settingsRaw)

function LeftSessions() {
  const { message } = AntdApp.useApp()
  const dispatch = useAppDispatch()
  const sessions = useTypedSelector((s) => s.session.list)
  const currentId = useTypedSelector((s) => s.chat.currentSessionId)
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const [q, setQ] = useState('')

  const filtered = sessions.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
  const groups = groupSessionsByTime(filtered)

  const stopRun = (id: string) => {
    abortSessionRun(id)
    message.info('已中止该会话的执行')
  }

  const del = async (id: string) => {
    abortSessionRun(id)
    await window.api.sessionDelete(id)
    dispatch(removeSession(id))
    if (currentId === id) dispatch(setSession(null))
    message.success('已删除')
  }

  return (
    <div className="sider-pane">
      <Input allowClear placeholder="搜索会话" value={q} onChange={(e) => setQ(e.target.value)} />
      <PendingConfirmBanner />
      <div className="session-list-scroll">
        {groups.length === 0 ? (
          <Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <div className="session-group-label">{group.label}</div>
              {group.sessions.map((item) => (
                  <div
                    key={item.id}
                    className={`session-item${item.id === currentId ? ' session-item--active' : ''}`}
                    onClick={() => dispatch(setSession(item.id))}
                  >
                    <SessionListIcon loading={Boolean(runningSessions[item.id])} />
                    <div className="session-item-main">
                      <div className="session-item-name" title={item.name}>
                        {item.name}
                      </div>
                    </div>
                    {runningSessions[item.id] ? (
                      <button
                        type="button"
                        className="session-item-stop"
                        title="中止执行"
                        onClick={(e) => {
                          e.stopPropagation()
                          stopRun(item.id)
                        }}
                      >
                        <Square size={10} strokeWidth={2} fill="currentColor" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="session-item-delete"
                      title="删除会话"
                      onClick={(e) => {
                        e.stopPropagation()
                        void del(item.id)
                      }}
                    >
                      <Trash2 size={12} strokeWidth={1.75} />
                    </button>
                  </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function IconTab({
  lineSvg,
  fillSvg,
  active,
  onClick,
  title
}: {
  lineSvg: string
  fillSvg: string
  active: boolean
  onClick: () => void
  title: string
}) {
  const svg = active ? fillSvg : lineSvg
  return (
    <button
      type="button"
      className={`activity-bar-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={title}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function AppShellInner() {
  const { message } = AntdApp.useApp()
  const dispatch = useAppDispatch()
  const config = useTypedSelector((s) => s.config.config)
  const sessions = useTypedSelector((s) => s.session.list)
  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const [siderKey, setSiderKey] = useState<'sessions' | 'wiki' | 'search'>('sessions')
  const { openFile } = useDetailPanel()
  const wikiEnabled = Boolean(config?.wiki?.enabled)

  const createSession = async () => {
    const s = await window.api.sessionCreate({ name: `会话 ${sessions.length + 1}` })
    dispatch(upsertSession(s))
    dispatch(setSession(s.id))
    message.success('已创建会话')
  }

  const handleFileSelect = (relPath: string) => {
    void openFile(relPath).catch((e) => {
      message.error(e instanceof Error ? e.message : String(e))
    })
  }

  const handleSearchSessionClick = (sessionId: string, messageId: string) => {
    dispatch(setSession(sessionId))
    dispatch(setScrollToMessageId(messageId))
  }

  const handleSearchFileClick = (relPath: string) => {
    const wikiRoot = config?.wiki?.rootPath ?? DEFAULT_WIKI_CONFIG.rootPath
    const isWikiPath = wikiEnabled && isUnderWikiRoot(relPath, wikiRoot)
    if (isWikiPath) {
      setSiderKey('wiki')
      requestFilePaneSelect({ relPath, preferWiki: true })
    } else {
      requestFilePaneSelect({ relPath })
    }
    handleFileSelect(relPath)
  }

  const handleCollectToWiki = (srcRelPath: string) => {
    void collectToWiki(srcRelPath, {
      wikiEnabled: Boolean(config?.wiki?.enabled),
      sessionId: currentSessionId,
      onMissingSession: () => message.warning('请先选择或创建一个会话'),
      onError: (text) => message.error(text),
      onSuccess: (text) => message.success(text)
    })
  }

  useEffect(() => {
    void window.api.sessionList().then((list) => {
      dispatch(setSessions(list))
      if (list[0]) dispatch(setSession(list[0].id))
    })
    void window.api.configGet().then((c) => dispatch(setConfig(c)))
    const off1 = window.api.onOpenSettings(() => dispatch(setSettingsOpen(true)))
    const off2 = window.api.onOpenAbout(() => dispatch(setAboutOpen(true)))
    const offTitle = window.api.sessionOnTitleGenerated(({ session }) => {
      dispatch(upsertSession(session))
    })
    const offFeishuStream = initFeishuRemoteStreamBridge()
    return () => {
      off1()
      off2()
      offTitle()
      offFeishuStream()
    }
  }, [dispatch])

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100vh' }}>
      <SplitPane id="leftSider" defaultSize={328} minSize={248} maxSize={520} side="left" className="app-sider">
        <div className="sa-split-pane-inner">
          <div className="activity-bar">
            <div className="activity-bar-top">
              <IconTab lineSvg={chatLineSvg} fillSvg={chatFillSvg} active={siderKey === 'sessions'} onClick={() => setSiderKey('sessions')} title="会话" />
              {wikiEnabled ? (
                <IconTab lineSvg={wikiLineSvg} fillSvg={wikiFillSvg} active={siderKey === 'wiki'} onClick={() => setSiderKey('wiki')} title="Wiki" />
              ) : null}
              <IconTab lineSvg={searchLineSvg} fillSvg={searchFillSvg} active={siderKey === 'search'} onClick={() => setSiderKey('search')} title="搜索" />
            </div>
            <div className="activity-bar-bottom">
              <button
                type="button"
                className="activity-bar-btn"
                onClick={() => dispatch(setSettingsOpen(true))}
                title="设置"
                dangerouslySetInnerHTML={{ __html: settingsSvg }}
              />
            </div>
          </div>
          <div className="sider-content">
            {(siderKey === 'sessions' || siderKey === 'search') && (
              <div className="app-pane-header sider-content-header">
                <span className="app-pane-header-title">{siderKey === 'sessions' ? '会话' : '搜索'}</span>
                {siderKey === 'sessions' ? (
                  <Button type="primary" size="small" className="sider-new-session-btn" onClick={() => void createSession()}>
                    新会话
                  </Button>
                ) : null}
              </div>
            )}
            <div className="sider-content-body">
              {siderKey === 'sessions' && <LeftSessions />}
              {siderKey === 'wiki' && wikiEnabled && (
                <WikiPane
                  workDir={config?.workDir ?? ''}
                  onFileSelect={handleFileSelect}
                  onSwitchToWikiTab={() => setSiderKey('wiki')}
                  onCollectToWiki={handleCollectToWiki}
                />
              )}
              <div className={siderKey === 'search' ? 'search-pane-mount' : 'search-pane-mount search-pane-mount--hidden'}>
                <SearchPane
                  onSessionResultClick={handleSearchSessionClick}
                  onFileResultClick={handleSearchFileClick}
                />
              </div>
            </div>
          </div>
        </div>
      </SplitPane>

      <main className="app-main" style={{ flex: 1, minWidth: 400 }}>
        <div className="app-pane-header app-main-header">
          <span className="app-pane-header-title">SpaceAssistant</span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatView />
        </div>
      </main>

      <SplitPane id="rightSider" defaultSize={240} minSize={180} maxSize={480} side="right" className="app-detail-sider">
        <DetailPanel />
      </SplitPane>

      <ConfigSettingsPage />
      <AboutModal />
    </div>
  )
}

function AppShell() {
  return (
    <DetailPanelProvider>
      <AppShellInner />
    </DetailPanelProvider>
  )
}

export default function App() {
  return <AppShell />
}
