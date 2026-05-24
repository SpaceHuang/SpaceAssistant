import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Empty, Input, Typography } from 'antd'

const { Text } = Typography
import { Square, Trash2 } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from './hooks'
import { setSessions, upsertSession, removeSession } from './store/sessionSlice'
import { setSession } from './store/chatSlice'
import { setConfig, setSettingsOpen, setAboutOpen } from './store/configSlice'
import { ChatView } from './components/Chat/ChatView'
import { ConfigModal } from './components/Config/ConfigModal'
import { AboutModal } from './components/Config/AboutModal'
import { FilePane } from './components/FilePane'
import { collectToWiki } from './services/wikiImportService'
import { DetailPanel, DetailPanelProvider, useDetailPanel } from './components/DetailPanel'
import { SplitPane } from './components/ui/SplitPane'
import { groupSessionsByTime } from './utils/groupSessions'
import { abortSessionRun } from './services/chatRunnerService'
import { SessionListIcon } from './components/SessionList/SessionListIcon'
import { PendingConfirmBanner } from './components/SessionList/PendingConfirmBanner'
import { PendingPlanBanner } from './components/SessionList/PendingPlanBanner'
import chatLineRaw from './assets/chat_3_line.svg?raw'
import chatFillRaw from './assets/chat_3_fill.svg?raw'
import folderLineRaw from './assets/folder_line.svg?raw'
import folderFillRaw from './assets/folder_fill.svg?raw'
import searchLineRaw from './assets/search_line.svg?raw'
import searchFillRaw from './assets/search_fill.svg?raw'
import settingsRaw from './assets/settings_1_line.svg?raw'

const patchSvg = (raw: string) => raw.replace(/fill="#09244B"/g, 'fill="currentColor"')

const chatLineSvg = patchSvg(chatLineRaw)
const chatFillSvg = patchSvg(chatFillRaw)
const folderLineSvg = patchSvg(folderLineRaw)
const folderFillSvg = patchSvg(folderFillRaw)
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
      <PendingPlanBanner />
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

function SearchPane() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Awaited<ReturnType<typeof window.api.searchExecute>>>([])
  const dispatch = useAppDispatch()

  const run = async () => {
    const rows = await window.api.searchExecute(q)
    setResults(rows)
  }

  return (
    <div className="sider-pane">
      <Input.Search placeholder="搜索聊天与文本文件" value={q} onChange={(e) => setQ(e.target.value)} onSearch={run} />
      <div className="session-list-scroll">
        {results.map((item) => (
          <div
            key={item.id}
            className="session-item"
            onClick={() => {
              if (item.sessionId) dispatch(setSession(item.sessionId))
            }}
          >
            <Text strong ellipsis>
              [{item.type}] {item.title}
            </Text>
            <div>
              <Text type="secondary" ellipsis>
                {item.preview}
              </Text>
            </div>
          </div>
        ))}
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
  const [siderKey, setSiderKey] = useState<'sessions' | 'files' | 'search'>('sessions')
  const { openFile } = useDetailPanel()

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
    return () => {
      off1()
      off2()
      offTitle()
    }
  }, [dispatch])

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100vh' }}>
      <SplitPane id="leftSider" defaultSize={328} minSize={248} maxSize={520} side="left" className="app-sider">
        <div style={{ display: 'flex', height: '100%', width: '100%' }}>
          <div className="activity-bar">
            <div className="activity-bar-top">
              <IconTab lineSvg={chatLineSvg} fillSvg={chatFillSvg} active={siderKey === 'sessions'} onClick={() => setSiderKey('sessions')} title="会话" />
              <IconTab lineSvg={folderLineSvg} fillSvg={folderFillSvg} active={siderKey === 'files'} onClick={() => setSiderKey('files')} title="文件" />
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
            {siderKey !== 'files' && (
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
              {siderKey === 'files' && (
                <FilePane workDir={config?.workDir ?? ''} onFileSelect={handleFileSelect} onCollectToWiki={handleCollectToWiki} />
              )}
              {siderKey === 'search' && <SearchPane />}
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

      <ConfigModal />
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
