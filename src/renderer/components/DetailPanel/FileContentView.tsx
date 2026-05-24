import { Spin, Typography } from 'antd'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { useDetailPanel } from './DetailPanelContext'
import { CodeView } from './CodeView'
import { MarkdownRenderView } from './MarkdownRenderView'
import { WikiIndexView } from './WikiIndexView'
import { ImageView } from './ImageView'
import { UnsupportedView } from './UnsupportedView'
import type { SearchMatch } from './searchUtils'

type Props = {
  searchHighlights?: SearchMatch[]
  currentHighlightIndex?: number
  wikiIndexView?: boolean
}

export function FileContentView({
  searchHighlights = [],
  currentHighlightIndex = -1,
  wikiIndexView = false
}: Props) {
  const {
    selectedFile,
    previewContent,
    imageDataUrl,
    fileType,
    viewMode,
    isLoading,
    loadError,
    unsupportedExt,
    tooLargeSize,
    openFile
  } = useDetailPanel()
  const wikiRoot = useTypedSelector((s) => s.config.config?.wiki?.rootPath ?? DEFAULT_WIKI_CONFIG.rootPath)

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

  if (fileType === 'markdown' && wikiIndexView) {
    return (
      <WikiIndexView
        content={previewContent}
        wikiRootPath={wikiRoot}
        onOpenEntry={(relPath) => void openFile(relPath)}
      />
    )
  }

  if (fileType === 'markdown' && viewMode === 'render') {
    return (
      <MarkdownRenderView
        content={previewContent}
        wikiRootPath={wikiRoot}
        onOpenFile={(relPath) => void openFile(relPath)}
      />
    )
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
