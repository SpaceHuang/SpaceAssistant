import { useCallback, useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { useTypedSelector } from '../../hooks'
import { useDetailPanel } from './DetailPanelContext'
import { FileToolbar } from './FileToolbar'
import { FileContentView } from './FileContentView'
import { SearchPanel } from './SearchPanel'
import { useWikiIndexViewState } from './WikiIndexView'
import { canShowCollectToWiki, collectToWiki } from '../../services/wikiImportService'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { SearchMatch } from './searchUtils'

export function FileOverlay() {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('common')
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const addressInputRef = useRef<HTMLInputElement>(null)

  const {
    contentMode,
    selectedFile,
    fileType,
    viewMode,
    previewContent,
    displayUrl,
    canNavigateBack,
    canNavigateForward,
    isWebViewLoading,
    isWebViewActive,
    closeFile,
    refreshFile,
    refreshPage,
    stopLoading,
    navigateBack,
    navigateForward,
    setViewMode,
    setDisplayUrl,
    submitDisplayUrl
  } = useDetailPanel()

  const wikiRoot = useTypedSelector((s) => s.config.config?.wiki?.rootPath ?? 'llm-wiki')
  const wikiEnabled = useTypedSelector((s) => s.config.config?.wiki?.enabled ?? false)
  const { isIndex, indexView, setIndexView } = useWikiIndexViewState(selectedFile, wikiRoot)

  const showCollectToWiki = Boolean(
    selectedFile && canShowCollectToWiki(selectedFile, wikiRoot, false, wikiEnabled)
  )

  const handleCollectToWiki = useCallback(() => {
    if (!selectedFile) return
    void collectToWiki(selectedFile, {
      wikiEnabled,
      sessionId,
      onMissingSession: () => message.warning(t('appShell.selectSessionFirst')),
      onError: (text) => message.error(text),
      onSuccess: (text) => message.success(text)
    })
  }, [message, selectedFile, sessionId, wikiEnabled])

  const [searchOpen, setSearchOpen] = useState(false)
  const [highlights, setHighlights] = useState<SearchMatch[]>([])
  const [currentHighlightIndex, setCurrentHighlightIndex] = useState(-1)

  const onHighlightsChange = useCallback((matches: SearchMatch[], index: number) => {
    setHighlights(matches)
    setCurrentHighlightIndex(index)
  }, [])

  const overlayActive = Boolean(selectedFile) || contentMode === 'url'
  const showWebChrome = isWebViewActive || contentMode === 'url'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!overlayActive) return
      const mod = e.ctrlKey || e.metaKey

      if (showWebChrome && mod && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        addressInputRef.current?.focus()
        addressInputRef.current?.select()
        return
      }

      if (showWebChrome && e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        navigateBack()
        return
      }

      if (showWebChrome && e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        navigateForward()
        return
      }

      if (showWebChrome && e.key === 'F5') {
        e.preventDefault()
        refreshPage(mod)
        return
      }

      if (showWebChrome && isWebViewLoading && e.key === 'Escape') {
        e.preventDefault()
        stopLoading()
        return
      }

      if (!selectedFile) return

      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        closeFile()
      }
      if (e.key === 'Escape' && searchOpen) {
        e.preventDefault()
        setSearchOpen(false)
      } else if (e.key === 'Escape' && !searchOpen && !isWebViewLoading) {
        closeFile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    closeFile,
    isWebViewLoading,
    navigateBack,
    navigateForward,
    overlayActive,
    refreshPage,
    searchOpen,
    selectedFile,
    showWebChrome,
    stopLoading
  ])

  if (!overlayActive) return null

  return (
    <div className="detail-file-overlay" tabIndex={0}>
      <FileToolbar
        filePath={selectedFile}
        fileType={fileType}
        viewMode={viewMode}
        previewContent={previewContent}
        showWebNavigation={showWebChrome}
        showAddressBar={showWebChrome}
        addressUrl={displayUrl}
        addressInputRef={addressInputRef}
        canGoBack={canNavigateBack}
        canGoForward={canNavigateForward}
        isWebViewLoading={isWebViewLoading}
        onAddressChange={setDisplayUrl}
        onAddressSubmit={submitDisplayUrl}
        onNavigateBack={navigateBack}
        onNavigateForward={navigateForward}
        onStopLoading={stopLoading}
        onViewModeChange={setViewMode}
        onClose={closeFile}
        onRefresh={() => void refreshFile()}
        showWikiIndexToggle={isIndex}
        wikiIndexView={indexView}
        onWikiIndexViewChange={setIndexView}
        showCollectToWiki={showCollectToWiki}
        onCollectToWiki={handleCollectToWiki}
      />
      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onHighlightsChange={onHighlightsChange}
      />
      <div className="detail-file-body">
        <FileContentView
          searchHighlights={highlights}
          currentHighlightIndex={currentHighlightIndex}
          wikiIndexView={indexView}
        />
      </div>
    </div>
  )
}
