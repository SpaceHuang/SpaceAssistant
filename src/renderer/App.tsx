import { useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button } from 'antd'
import { useAppDispatch, useTypedSelector } from './hooks'
import { setSessions, upsertSession } from './store/sessionSlice'
import { setSession, setScrollToMessageId } from './store/chatSlice'
import { setConfig, setSettingsOpen, setAboutOpen } from './store/configSlice'
import { ChatView } from './components/Chat/ChatView'
import { ConfigSettingsPage } from './components/Config/ConfigModal'
import { AboutModal } from './components/Config/AboutModal'
import { WikiPane, type WikiPaneHandle } from './components/WikiPane'
import { WikiPaneToolbar } from './components/WikiPane/WikiPaneToolbar'
import { collectToWiki } from './services/wikiImportService'
import { ensureWorkDirForSession } from './services/workDirSessionSync'
import { DetailPanel, DetailPanelProvider, useDetailPanel } from './components/DetailPanel'
import { SplitPane } from './components/ui/SplitPane'
import { initFeishuRemoteStreamBridge } from './services/feishuRemoteStreamService'
import { initContextUsageStreamBridge } from './services/contextUsageStreamService'
import { initConfirmStores } from './services/confirmStoresInit'
import { SessionListPane } from './components/SessionList/SessionListPane'
import { SearchPane } from './components/Search/SearchPane'
import { SearchProvider } from './components/Search/SearchProvider'
import { SearchBar } from './components/Search/SearchBar'
import { requestFilePaneSelect, isUnderWikiRoot } from './services/filePaneNavigation'
import { DEFAULT_WIKI_CONFIG } from '../shared/domainTypes'
import { syncLocaleFromConfig } from './i18n/localeSync'
import { useTypedTranslation } from './i18n/useTypedTranslation'
import { formatUserFacingError } from './utils/formatUserFacingError'
import { patchSvg } from './utils/patchSvg'
import chatLineRaw from './assets/chat_3_line.svg?raw'
import chatFillRaw from './assets/chat_3_fill.svg?raw'
import wikiLineRaw from './assets/book_2_ai_line.svg?raw'
import wikiFillRaw from './assets/book_2_ai_fill.svg?raw'
import searchLineRaw from './assets/search_line.svg?raw'
import searchFillRaw from './assets/search_fill.svg?raw'
import settingsRaw from './assets/settings_1_line.svg?raw'
import { TitleBar } from './components/TitleBar/TitleBar'

const chatLineSvg = patchSvg(chatLineRaw)
const chatFillSvg = patchSvg(chatFillRaw)
const wikiLineSvg = patchSvg(wikiLineRaw)
const wikiFillSvg = patchSvg(wikiFillRaw)
const searchLineSvg = patchSvg(searchLineRaw)
const searchFillSvg = patchSvg(searchFillRaw)
const settingsSvg = patchSvg(settingsRaw)

function IconTab({
  lineSvg,
  fillSvg,
  active,
  onClick,
  label
}: {
  lineSvg: string
  fillSvg: string
  active: boolean
  onClick: () => void
  label: string
}) {
  const svg = active ? fillSvg : lineSvg
  return (
    <button
      type="button"
      role="tab"
      className={`activity-bar-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-selected={active}
    >
      <span className="activity-bar-btn-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    </button>
  )
}

function AppShellInner() {
  const { t } = useTypedTranslation('common')
  const { message } = AntdApp.useApp()
  const dispatch = useAppDispatch()
  const config = useTypedSelector((s) => s.config.config)
  const sessions = useTypedSelector((s) => s.session.list)
  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const [siderKey, setSiderKey] = useState<'sessions' | 'wiki' | 'search'>('sessions')
  const [wikiInitialized, setWikiInitialized] = useState<boolean | null>(null)
  const wikiPaneRef = useRef<WikiPaneHandle>(null)
  const { openFile } = useDetailPanel()
  const wikiEnabled = Boolean(config?.wiki?.enabled)

  const createSession = async () => {
    try {
      const s = await window.api.sessionCreate({
        name: t('session.defaultName', { index: sessions.length + 1 })
      })
      dispatch(upsertSession(s))
      dispatch(setSession(s.id))
      message.success(t('appShell.sessionCreated'))
    } catch (e) {
      message.error(formatUserFacingError(e instanceof Error ? e.message : t('appShell.createSessionFailed')))
    }
  }

  const handleFileSelect = (relPath: string) => {
    void openFile(relPath).catch((e) => {
      message.error(formatUserFacingError(e instanceof Error ? e.message : String(e)))
    })
  }

  const handleSearchSessionClick = (sessionId: string, messageId: string) => {
    void (async () => {
      const session =
        sessions.find((s) => s.id === sessionId) ?? (await window.api.sessionGet(sessionId))
      if (session && config) {
        const sync = await ensureWorkDirForSession(session, config, dispatch)
        if (!sync.ok) {
          message.error(formatUserFacingError(sync.error))
          return
        }
      }
      dispatch(setSession(sessionId))
      dispatch(setScrollToMessageId(messageId))
    })()
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
      onMissingSession: () => message.warning(t('appShell.selectSessionFirst')),
      onError: (text) => message.error(formatUserFacingError(text)),
      onSuccess: (text) => message.success(text)
    })
  }

  const siderHeaderTitle =
    siderKey === 'sessions' ? t('activity.sessions') : siderKey === 'wiki' ? t('activity.wiki') : t('activity.search')

  useEffect(() => {
    initConfirmStores()
    void window.api
      .sessionList()
      .then((list) => {
        dispatch(setSessions(list))
        if (list[0]) dispatch(setSession(list[0].id))
      })
      .catch((e) => {
        message.error(formatUserFacingError(e instanceof Error ? e.message : t('appShell.loadSessionsFailed')))
      })
    void window.api.configGet().then((c) => {
      dispatch(setConfig(c))
      syncLocaleFromConfig(c.locale)
    })
    const off1 = window.api.onOpenSettings(() => dispatch(setSettingsOpen(true)))
    const off2 = window.api.onOpenAbout(() => dispatch(setAboutOpen(true)))
    const offTitle = window.api.sessionOnTitleGenerated(({ session }) => {
      dispatch(upsertSession(session))
    })
    const offFeishuStream = initFeishuRemoteStreamBridge()
    const offContextUsage = initContextUsageStreamBridge()
    return () => {
      off1()
      off2()
      offTitle()
      offFeishuStream()
      offContextUsage()
    }
  }, [dispatch])

  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-shell">
      <SplitPane id="leftSider" defaultSize={328} minSize={248} maxSize={520} side="left" className="app-sider">
        <div className="sa-split-pane-inner">
          <nav className="activity-bar" aria-label={t('activity.bar')}>
            <div className="activity-bar-top" role="tablist" aria-orientation="vertical">
              <IconTab
                lineSvg={chatLineSvg}
                fillSvg={chatFillSvg}
                active={siderKey === 'sessions'}
                onClick={() => setSiderKey('sessions')}
                label={t('activity.sessions')}
              />
              {wikiEnabled ? (
                <IconTab
                  lineSvg={wikiLineSvg}
                  fillSvg={wikiFillSvg}
                  active={siderKey === 'wiki'}
                  onClick={() => setSiderKey('wiki')}
                  label={t('activity.wiki')}
                />
              ) : null}
              <IconTab
                lineSvg={searchLineSvg}
                fillSvg={searchFillSvg}
                active={siderKey === 'search'}
                onClick={() => setSiderKey('search')}
                label={t('activity.search')}
              />
            </div>
            <div className="activity-bar-bottom">
              <button
                type="button"
                className="activity-bar-btn"
                onClick={() => dispatch(setSettingsOpen(true))}
                title={t('activity.settings')}
                aria-label={t('activity.settings')}
              >
                <span className="activity-bar-btn-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: settingsSvg }} />
              </button>
            </div>
          </nav>
          <div className="sider-content">
            <div className="app-pane-header sider-content-header">
              <span className="app-pane-header-title">{siderHeaderTitle}</span>
              {siderKey === 'sessions' ? (
                <Button type="primary" size="small" className="sider-new-session-btn" onClick={() => void createSession()}>
                  {t('session.new')}
                </Button>
              ) : null}
              {siderKey === 'wiki' && wikiEnabled ? (
                <WikiPaneToolbar
                  showOpen={wikiInitialized === true}
                  refreshDisabled={!wikiInitialized}
                  onOpen={() => wikiPaneRef.current?.openInExplorer()}
                  onRefresh={() => wikiPaneRef.current?.refresh()}
                />
              ) : null}
            </div>
            <div className="sider-content-body">
              {siderKey === 'sessions' && <SessionListPane />}
              {siderKey === 'wiki' && wikiEnabled && (
                <WikiPane
                  ref={wikiPaneRef}
                  workDir={config?.workDir ?? ''}
                  onFileSelect={handleFileSelect}
                  onSwitchToWikiTab={() => setSiderKey('wiki')}
                  onCollectToWiki={handleCollectToWiki}
                  onInitStateChange={setWikiInitialized}
                />
              )}
              <div className={siderKey === 'search' ? 'search-pane-mount' : 'search-pane-mount search-pane-mount--hidden'}>
                <SearchPane onSessionResultClick={handleSearchSessionClick} onFileResultClick={handleSearchFileClick} />
              </div>
            </div>
          </div>
        </div>
      </SplitPane>

      <main className="app-main">
        <div className="app-main-body">
          <ChatView />
        </div>
      </main>

      <SplitPane id="rightSider" defaultSize={320} minSize={180} maxSize={960} side="right" className="app-detail-sider">
        <DetailPanel />
      </SplitPane>

      <ConfigSettingsPage />
      <AboutModal />
      </div>
    </div>
  )
}

function AppShell() {
  return (
    <DetailPanelProvider>
      <SearchProvider>
        <AppShellInner />
        <SearchBar />
      </SearchProvider>
    </DetailPanelProvider>
  )
}

export default function App() {
  return <AppShell />
}
