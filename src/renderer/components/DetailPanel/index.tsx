import { Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { FileOverlay } from './FileOverlay'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { ResizeHandle } from './ResizeHandle'
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
        <div className="detail-panel-placeholder">
          <Typography.Text type="secondary">选择文件以预览内容</Typography.Text>
        </div>
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
