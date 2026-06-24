import { useCallback, useEffect, useRef } from 'react'
import { App } from 'antd'
import { useTypedSelector } from '../../hooks'
import { useDetailPanel } from './DetailPanelContext'
import { FileToolbar } from './FileToolbar'
import { FileContentBody } from './FileContentBody'
import { FileContentView } from './FileContentView'
import { useWikiIndexViewState } from './WikiIndexView'
import { canShowCollectToWiki, collectToWiki } from '../../services/wikiImportService'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

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
    submitDisplayUrl,
    registerFileBodyElement
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

      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        closeFile()
      }
      if (e.key === 'Escape' && !isWebViewLoading) {
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
      <FileContentBody registerFileBodyElement={registerFileBodyElement}>
        <FileContentView wikiIndexView={indexView} />
      </FileContentBody>
    </div>
  )
}
