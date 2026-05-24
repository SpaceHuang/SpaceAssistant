import { useDetailPanel } from './DetailPanelContext'
import { FileOverlay } from './FileOverlay'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { ResizeHandle } from './ResizeHandle'
import { PlanPanel } from '../Plan/PlanPanel'
import { useTypedSelector } from '../../hooks'
import './detailPanel.css'

export { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'

export function DetailPanel() {
  const { selectedFile, referencedFilesHeight, setReferencedFilesHeight, resetReferencedFilesHeight } = useDetailPanel()
  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)

  if (selectedFile) {
    return <FileOverlay />
  }

  return (
    <div className="detail-panel-split">
      <div
        className="detail-panel-top"
        style={{ flex: 1 - referencedFilesHeight }}
      >
        <PlanPanel sessionId={currentSessionId} />
      </div>
      <ResizeHandle
        currentRatio={referencedFilesHeight}
        onResize={setReferencedFilesHeight}
        onDoubleClick={resetReferencedFilesHeight}
      />
      <div
        className="detail-panel-bottom"
        style={{ flex: referencedFilesHeight }}
      >
        <ReferencedFilesPanel sessionId={currentSessionId} />
      </div>
    </div>
  )
}
