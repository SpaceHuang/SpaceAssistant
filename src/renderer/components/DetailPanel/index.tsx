import { App } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { FileOverlay } from './FileOverlay'
import { ReferencedFilesPanel } from './ReferencedFilesPanel'
import { FeishuRemoteStatusBar } from './FeishuRemoteStatusBar'
import { ResizeHandle } from './ResizeHandle'
import { DetailPanelFileList } from './DetailPanelFileList'
import { useTypedSelector } from '../../hooks'
import { collectToWiki } from '../../services/wikiImportService'
import './detailPanel.css'

export { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'

export function DetailPanel() {
  const { message } = App.useApp()
  const { selectedFile, contentMode, referencedFilesHeight, setReferencedFilesHeight, resetReferencedFilesHeight, openFile, openUrl } =
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

  if (selectedFile || contentMode === 'url') {
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
      <div className="detail-panel-top" role="region" aria-label="项目文件">
        <DetailPanelFileList
          workDir={config?.workDir ?? ''}
          onFileSelect={handleFileSelect}
          onCollectToWiki={handleCollectToWiki}
          onOpenUrl={(url) => {
            void openUrl(url).catch((e) => {
              message.error(e instanceof Error ? e.message : String(e))
            })
          }}
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
      <FeishuRemoteStatusBar />
    </div>
  )
}
