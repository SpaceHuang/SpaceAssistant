import { useDetailPanel } from './DetailPanelContext'
import { FileOverlay } from './FileOverlay'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { FeishuRemoteStatusBar } from './FeishuRemoteStatusBar'
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

  const topFr = 1 - referencedFilesHeight
  const bottomFr = referencedFilesHeight

  return (
    <div
      className="detail-panel-split"
      style={{
        gridTemplateRows: `minmax(0, ${topFr}fr) var(--detail-resize-handle-height) minmax(0, ${bottomFr}fr) var(--feishu-remote-status-bar-height)`
      }}
    >
      <div className="detail-panel-top">
        <PlanPanel sessionId={currentSessionId} />
      </div>
      <ResizeHandle
        currentRatio={referencedFilesHeight}
        onResize={setReferencedFilesHeight}
        onDoubleClick={resetReferencedFilesHeight}
      />
      <div className="detail-panel-bottom">
        <ReferencedFilesPanel sessionId={currentSessionId} />
      </div>
      <FeishuRemoteStatusBar />
    </div>
  )
}
