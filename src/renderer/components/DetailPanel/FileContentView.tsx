import { useCallback, useState } from 'react'
import { Modal } from 'antd'
import { Spin, Typography } from 'antd'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { isUnderWikiRoot, requestFilePaneSelect } from '../../services/filePaneNavigation'
import { openExternalUrl } from '../../services/openExternalUrl'
import { useDetailPanel } from './DetailPanelContext'
import { CodeView } from './CodeView'
import { MarkdownRenderView } from './MarkdownRenderView'
import { WikiIndexView } from './WikiIndexView'
import { ImageView } from './ImageView'
import { UnsupportedView } from './UnsupportedView'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { WebView } from './WebView'
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
    contentMode,
    selectedFile,
    previewContent,
    imageDataUrl,
    fileType,
    viewMode,
    isLoading,
    loadError,
    unsupportedExt,
    tooLargeSize,
    selectedUrl,
    localFileViewerUrl,
    isWebViewLoading,
    webViewError,
    isWebViewActive,
    openFile,
    openUrl,
    registerWebViewController,
    onWebViewLoadStart,
    onWebViewLoadFinish,
    onWebViewLoadError
  } = useDetailPanel()
  const { t } = useTypedTranslation('detailPanel')
  const wikiRoot = useTypedSelector((s) => s.config.config?.wiki?.rootPath ?? DEFAULT_WIKI_CONFIG.rootPath)
  const [pendingScrollFragment, setPendingScrollFragment] = useState<string | null>(null)

  const handleOpenLinkedFile = useCallback(
    (relPath: string, fragment?: string) => {
      requestFilePaneSelect({ relPath, preferWiki: isUnderWikiRoot(relPath, wikiRoot) })
      if (fragment) setPendingScrollFragment(fragment)
      void openFile(relPath)
    },
    [openFile, wikiRoot]
  )

  const handleLinkClick = useCallback(
    (url: string, target: string) => {
      if (target === '_blank') {
        Modal.confirm({
          title: '打开链接',
          content: url,
          okText: '在查看器中打开',
          cancelText: '在外部浏览器打开',
          onOk: () => openUrl(url),
          onCancel: () => void openExternalUrl(url)
        })
        return
      }
      void openUrl(url)
    },
    [openUrl]
  )

  const webViewUrl = contentMode === 'url' ? selectedUrl : localFileViewerUrl

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
            {t('fileView.fileSize')}{(tooLargeSize / 1024 / 1024).toFixed(2)} MB
          </Typography.Text>
        )}
      </div>
    )
  }

  if (isWebViewActive && webViewUrl) {
    return (
      <WebView
        url={webViewUrl}
        isLoading={isWebViewLoading}
        error={webViewError}
        onLoadStart={onWebViewLoadStart}
        onLoadFinish={onWebViewLoadFinish}
        onLoadError={onWebViewLoadError}
        onLinkClick={handleLinkClick}
        onControllerRegister={registerWebViewController}
      />
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
        onOpenEntry={handleOpenLinkedFile}
      />
    )
  }

  if (fileType === 'markdown' && viewMode === 'render') {
    return (
      <MarkdownRenderView
        content={previewContent}
        wikiRootPath={wikiRoot}
        baseRelPath={selectedFile}
        onOpenFile={handleOpenLinkedFile}
        pendingScrollFragment={pendingScrollFragment}
        onPendingScrollFragmentHandled={() => setPendingScrollFragment(null)}
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
