import { useCallback, useEffect, useState } from 'react'
import { App } from 'antd'
import { useTypedSelector } from '../../hooks'
import { useDetailPanel } from './DetailPanelContext'
import { FileToolbar } from './FileToolbar'
import { FileContentView } from './FileContentView'
import { SearchPanel } from './SearchPanel'
import { useWikiIndexViewState } from './WikiIndexView'
import { canShowCollectToWiki, collectToWiki } from '../../services/wikiImportService'
import type { SearchMatch } from './searchUtils'

export function FileOverlay() {
  const { message } = App.useApp()
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)

  const {
    selectedFile,
    fileType,
    viewMode,
    previewContent,
    closeFile,
    refreshFile,
    setViewMode
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
      onMissingSession: () => message.warning('请先选择或创建一个会话'),
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedFile) return
      const mod = e.ctrlKey || e.metaKey
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
      } else if (e.key === 'Escape' && !searchOpen) {
        closeFile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeFile, searchOpen, selectedFile])

  if (!selectedFile || !fileType) return null

  return (
    <div className="detail-file-overlay" tabIndex={0}>
      <FileToolbar
        filePath={selectedFile}
        fileType={fileType}
        viewMode={viewMode}
        previewContent={previewContent}
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
