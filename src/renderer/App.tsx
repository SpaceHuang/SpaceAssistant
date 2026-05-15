import { useEffect, useState } from 'react'
import { Button, Empty, Input, Layout, List, Typography, message } from 'antd'
import { Provider } from 'react-redux'
import { store } from './store'
import { useAppDispatch, useTypedSelector } from './hooks'
import { setSessions, upsertSession, removeSession } from './store/sessionSlice'
import { setSession } from './store/chatSlice'
import { setConfig, setSettingsOpen, setAboutOpen } from './store/configSlice'
import { ChatView } from './components/Chat/ChatView'
import { ConfigModal } from './components/Config/ConfigModal'
import { AboutModal } from './components/Config/AboutModal'
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

const { Text } = Typography

function LeftSessions() {
  const dispatch = useAppDispatch()
  const sessions = useTypedSelector((s) => s.session.list)
  const currentId = useTypedSelector((s) => s.chat.currentSessionId)
  const [q, setQ] = useState('')

  const filtered = sessions.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))

  const create = async () => {
    const s = await window.api.sessionCreate({ name: `会话 ${sessions.length + 1}` })
    dispatch(upsertSession(s))
    dispatch(setSession(s.id))
    message.success('已创建会话')
  }

  const del = async (id: string) => {
    await window.api.sessionDelete(id)
    dispatch(removeSession(id))
    if (currentId === id) dispatch(setSession(null))
    message.success('已删除')
  }

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <Button type="primary" block onClick={create}>
        新会话
      </Button>
      <Input allowClear placeholder="搜索会话" value={q} onChange={(e) => setQ(e.target.value)} />
      <List
        size="small"
        dataSource={filtered}
        style={{ flex: 1, overflow: 'auto' }}
        locale={{ emptyText: <Empty description="暂无会话" /> }}
        renderItem={(item) => (
          <List.Item
            style={{
              cursor: 'pointer',
              background: item.id === currentId ? 'rgba(22,119,255,0.12)' : undefined,
              padding: '8px 10px',
              borderRadius: 8
            }}
            onClick={() => dispatch(setSession(item.id))}
            actions={[
              <Button type="link" danger size="small" onClick={(e) => (e.stopPropagation(), void del(item.id))}>
                删除
              </Button>
            ]}
          >
            <List.Item.Meta title={item.name} description={<Text ellipsis>{item.preview || ' '}</Text>} />
          </List.Item>
        )}
      />
    </div>
  )
}

function FilePane() {
  const [rel, setRel] = useState('')
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof window.api.fileListDirectory>>>([])
  const [preview, setPreview] = useState('')

  const load = async (r: string) => {
    try {
      const list = await window.api.fileListDirectory(r)
      setEntries(list)
      setRel(r)
      setPreview('')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load('')
  }, [])

  return (
    <div style={{ padding: 8, height: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Text type="secondary" ellipsis>
        {rel || '.'}
      </Text>
      <List
        size="small"
        dataSource={entries}
        style={{ flex: 1, overflow: 'auto' }}
        renderItem={(item) => (
          <List.Item
            style={{ cursor: 'pointer' }}
            onClick={async () => {
              if (item.isDirectory) {
                const next = rel ? `${rel}/${item.name}` : item.name
                await load(next)
              } else {
                try {
                  const fp = rel ? `${rel}/${item.name}` : item.name
                  const r = await window.api.fileReadFile(fp)
                  setPreview(r.content.slice(0, 4000))
                } catch (e) {
                  message.error(e instanceof Error ? e.message : String(e))
                }
              }
            }}
          >
            {item.isDirectory ? '📁' : '📄'} {item.name}
          </List.Item>
        )}
      />
      <div style={{ maxHeight: 160, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{preview}</div>
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
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <Input.Search placeholder="搜索聊天与文本文件" value={q} onChange={(e) => setQ(e.target.value)} onSearch={run} />
      <List
        size="small"
        dataSource={results}
        style={{ flex: 1, overflow: 'auto' }}
        renderItem={(item) => (
          <List.Item
            style={{ cursor: 'pointer' }}
            onClick={() => {
              if (item.sessionId) dispatch(setSession(item.sessionId))
            }}
          >
            <List.Item.Meta title={`[${item.type}] ${item.title}`} description={<Text ellipsis>{item.preview}</Text>} />
          </List.Item>
        )}
      />
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

function AppShell() {
  const dispatch = useAppDispatch()
  const [siderKey, setSiderKey] = useState<'sessions' | 'files' | 'search'>('sessions')

  useEffect(() => {
    void window.api.sessionList().then((list) => {
      dispatch(setSessions(list))
      if (list[0]) dispatch(setSession(list[0].id))
    })
    void window.api.configGet().then((c) => dispatch(setConfig(c)))
    const off1 = window.api.onOpenSettings(() => dispatch(setSettingsOpen(true)))
    const off2 = window.api.onOpenAbout(() => dispatch(setAboutOpen(true)))
    return () => {
      off1()
      off2()
    }
  }, [dispatch])

  return (
    <Layout style={{ height: '100vh' }}>
      <Layout.Sider width={328} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', height: '100%' }}>
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
            <div className="sider-content-header">
              <Text strong>{siderKey === 'sessions' ? '会话' : siderKey === 'files' ? '文件' : '搜索'}</Text>
            </div>
            <div className="sider-content-body">
              {siderKey === 'sessions' && <LeftSessions />}
              {siderKey === 'files' && <FilePane />}
              {siderKey === 'search' && <SearchPane />}
            </div>
          </div>
        </div>
      </Layout.Sider>
      <Layout.Content style={{ display: 'flex', flexDirection: 'column', minWidth: 400 }}>
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0' }}>
          <Text strong>SpaceAssistant</Text>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatView />
        </div>
      </Layout.Content>
      <Layout.Sider width={240} theme="light" style={{ borderLeft: '1px solid #f0f0f0', padding: 16 }}>
        <Text type="secondary">右侧栏预留（功能开发中）</Text>
      </Layout.Sider>
      <ConfigModal />
      <AboutModal />
    </Layout>
  )
}

export default function App() {
  return (
    <Provider store={store}>
      <AppShell />
    </Provider>
  )
}
