import { Spin, Typography } from 'antd'
import { useDetailPanel } from './DetailPanelContext'
import { CodeView } from './CodeView'
import { MarkdownRenderView } from './MarkdownRenderView'
import { ImageView } from './ImageView'
import { UnsupportedView } from './UnsupportedView'
import type { SearchMatch } from './searchUtils'

type Props = {
  searchHighlights?: SearchMatch[]
  currentHighlightIndex?: number
}

export function FileContentView({ searchHighlights = [], currentHighlightIndex = -1 }: Props) {
  const {
    selectedFile,
    previewContent,
    imageDataUrl,
    fileType,
    viewMode,
    isLoading,
    loadError,
    unsupportedExt,
    tooLargeSize
  } = useDetailPanel()

  if (isLoading) {
    return (
      <div className="detail-content-loading">
        <Spin size="small" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="detail-content-error">
        <Typography.Text type="danger">{loadError}</Typography.Text>
        {tooLargeSize != null && (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            文件大小：{(tooLargeSize / 1024 / 1024).toFixed(2)} MB
          </Typography.Text>
        )}
      </div>
    )
  }

  if (fileType === 'unsupported') {
    return <UnsupportedView ext={unsupportedExt} />
  }

  if (fileType === 'image' && imageDataUrl && selectedFile) {
    return <ImageView dataUrl={imageDataUrl} alt={selectedFile} />
  }

  if (previewContent == null || !selectedFile) {
    return null
  }

  if (fileType === 'markdown' && viewMode === 'render') {
    return <MarkdownRenderView content={previewContent} />
  }

  return (
    <CodeView
      content={previewContent}
      filePath={selectedFile}
      highlights={searchHighlights}
      currentHighlightIndex={currentHighlightIndex}
    />
  )
}
