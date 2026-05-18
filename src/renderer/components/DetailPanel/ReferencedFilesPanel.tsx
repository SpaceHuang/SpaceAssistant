// src/renderer/components/DetailPanel/ReferencedFilesPanel.tsx
import { Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { useReferencedFiles } from './useReferencedFiles'
import { ReferencedFileItem } from './ReferencedFileItem'

interface ReferencedFilesPanelProps {
  sessionId: string | null
}

export function ReferencedFilesPanel({ sessionId }: ReferencedFilesPanelProps) {
  const files = useReferencedFiles(sessionId)
  const { selectedFile, openFile } = useDetailPanel()

  const handleFileClick = (path: string) => {
    if (path === selectedFile) return
    void openFile(path)
  }

  return (
    <div className="referenced-files-panel">
      <div className="referenced-files-header">
        <span className="referenced-files-title">引用的文件</span>
        {files.length > 0 && (
          <span className="referenced-files-count">{files.length}</span>
        )}
      </div>
      <div className="referenced-files-list">
        {files.length === 0 ? (
          <div className="referenced-files-empty">
            <Typography.Text type="secondary">暂无引用的文件</Typography.Text>
          </div>
        ) : (
          files.map((file) => (
            <ReferencedFileItem
              key={file.path}
              file={file}
              isActive={file.path === selectedFile}
              onClick={() => handleFileClick(file.path)}
            />
          ))
        )}
      </div>
    </div>
  )
}