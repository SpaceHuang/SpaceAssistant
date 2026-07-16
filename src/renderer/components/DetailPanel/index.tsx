import { App } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { FileOverlay } from './FileOverlay'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { RemoteStatusBar } from './RemoteStatusBar'
import { ResizeHandle } from './ResizeHandle'
import { DetailPanelFileList } from './DetailPanelFileList'
import { useTypedSelector } from '../../hooks'
import { collectToWiki } from '../../services/wikiImportService'
import './detailPanel.css'

export { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'

export function DetailPanel() {
  const { message } = App.useApp()
  const { selectedFile, contentMode, referencedFilesHeight, setReferencedFilesHeight, resetReferencedFilesHeight, openFile } =
    useDetailPanel()
  const config = useTypedSelector((s) => s.config.config)
  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)

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

  // 文件查看器以覆盖层形式叠加在文件列表之上：文件列表（含目录展开状态、选中态等）
  // 始终保持挂载，仅在查看文件时通过 display 隐藏，避免关闭查看器后目录树被重置为折叠。
  const showOverlay = Boolean(selectedFile) || contentMode === 'url'

  const topFr = 1 - referencedFilesHeight
  const bottomFr = referencedFilesHeight

  return (
    <>
      <div
        className="detail-panel-split"
        style={{
          display: showOverlay ? 'none' : 'grid',
          gridTemplateRows: `minmax(0, ${topFr}fr) var(--detail-resize-handle-height) minmax(0, ${bottomFr}fr) var(--remote-status-bar-height)`
        }}
      >
      <div className="detail-panel-top" role="region" aria-label="项目文件">
        <DetailPanelFileList
          workDir={config?.workDir ?? ''}
          onFileSelect={handleFileSelect}
          onCollectToWiki={handleCollectToWiki}
        />
      </div>
      <ResizeHandle
        currentRatio={referencedFilesHeight}
        onResize={setReferencedFilesHeight}
        onDoubleClick={resetReferencedFilesHeight}
      />
      <div className="detail-panel-bottom">
        <ReferencedFilesPanel sessionId={currentSessionId} />
      </div>
      <RemoteStatusBar />
      </div>
      {showOverlay ? <FileOverlay /> : null}
    </>
  )
}
