import { useCallback, useEffect, useState } from 'react'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { setSession } from '../../store/chatSlice'
import { getPendingPlanMeta } from '../../../shared/planTypes'
import { useDetailPanel } from './DetailPanelContext'
import { FileToolbar } from './FileToolbar'
import { FileContentView } from './FileContentView'
import { SearchPanel } from './SearchPanel'
import type { SearchMatch } from './searchUtils'

export function FileOverlay() {
  const dispatch = useAppDispatch()
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const sessionMeta = useTypedSelector((s) =>
    sessionId ? s.session.list.find((x) => x.id === sessionId)?.metadata : undefined
  )
  const hasPendingPlan = getPendingPlanMeta(sessionMeta)?.status === 'awaiting_approval'

  const {
    selectedFile,
    fileType,
    viewMode,
    previewContent,
    closeFile,
    refreshFile,
    setViewMode
  } = useDetailPanel()

  const openPendingPlan = () => {
    if (sessionId) dispatch(setSession(sessionId))
    closeFile()
    window.dispatchEvent(new CustomEvent('plan-focus'))
  }

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
        onPendingPlanClick={hasPendingPlan ? openPendingPlan : undefined}
      />
      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onHighlightsChange={onHighlightsChange}
      />
      <div className="detail-file-body">
        <FileContentView searchHighlights={highlights} currentHighlightIndex={currentHighlightIndex} />
      </div>
    </div>
  )
}
