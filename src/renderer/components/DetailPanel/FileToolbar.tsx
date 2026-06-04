import { useRef, type RefObject } from 'react'
import { App, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ArrowLeft,
  ArrowRight,
  BookPlus,
  ExternalLink,
  FileDown,
  FolderOpen,
  RefreshCw,
  Square,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { FileTypeCategory } from '../../../shared/fileTypes'
import type { ViewMode } from './DetailPanelContext'
import { MarkdownRenderView } from './MarkdownRenderView'
import eyeLineRaw from '../../assets/eye_line.svg?raw'
import codeLineRaw from '../../assets/code_line.svg?raw'

const patchMingcute = (raw: string) => raw.replace(/fill="#09244B"/g, 'fill="currentColor"')
const markdownViewIcons = {
  render: patchMingcute(eyeLineRaw),
  code: patchMingcute(codeLineRaw)
}

const ICON_SIZE = 16
const ICON_STROKE = 2

function fileBaseName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const i = normalized.lastIndexOf('/')
  return i >= 0 ? normalized.slice(i + 1) : normalized
}

function ToolbarBtn({
  title,
  icon: Icon,
  onClick,
  disabled = false
}: {
  title: string
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="detail-toolbar-btn"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="detail-toolbar-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
    </button>
  )
}

type Props = {
  filePath?: string | null
  fileType?: FileTypeCategory | null
  viewMode: ViewMode
  previewContent: string | null
  showWebNavigation?: boolean
  showAddressBar?: boolean
  addressUrl?: string
  addressInputRef?: RefObject<HTMLInputElement>
  canGoBack?: boolean
  canGoForward?: boolean
  isWebViewLoading?: boolean
  onAddressChange?: (url: string) => void
  onAddressSubmit?: () => void
  onNavigateBack?: () => void
  onNavigateForward?: () => void
  onStopLoading?: () => void
  onViewModeChange: (mode: ViewMode) => void
  onClose: () => void
  onRefresh: () => void
  showWikiIndexToggle?: boolean
  wikiIndexView?: boolean
  onWikiIndexViewChange?: (enabled: boolean) => void
  showCollectToWiki?: boolean
  onCollectToWiki?: () => void
}

export function FileToolbar({
  filePath = null,
  fileType = null,
  viewMode,
  previewContent,
  showWebNavigation = false,
  showAddressBar = false,
  addressUrl = '',
  addressInputRef,
  canGoBack = false,
  canGoForward = false,
  isWebViewLoading = false,
  onAddressChange,
  onAddressSubmit,
  onNavigateBack,
  onNavigateForward,
  onStopLoading,
  onViewModeChange,
  onClose,
  onRefresh,
  showWikiIndexToggle = false,
  wikiIndexView = false,
  onWikiIndexViewChange,
  showCollectToWiki = false,
  onCollectToWiki
}: Props) {
  const { message } = App.useApp()
  const fallbackAddressRef = useRef<HTMLInputElement>(null)
  const inputRef = addressInputRef ?? fallbackAddressRef
  const isMarkdown = fileType === 'markdown'
  const isHtml = fileType === 'html'
  const hasFilePath = Boolean(filePath)

  const handleOpenInSystem = async () => {
    if (!filePath) return
    const r = await window.api.fileOpenInSystem(filePath)
    if (!r.ok) message.error(r.error ?? '打开失败')
  }

  const handleShowInExplorer = async () => {
    if (!filePath) return
    const r = await window.api.fileShowInExplorer(filePath)
    if (!r.ok) message.error(r.error ?? '打开目录失败')
  }

  const handleExportPdf = async () => {
    if (!previewContent || !filePath) return
    const html = renderToStaticMarkup(<MarkdownRenderView content={previewContent} />)
    const r = await window.api.fileExportPdf({ htmlContent: html, defaultPath: filePath })
    if (r.ok) message.success(`已导出至 ${r.path}`)
    else if (!r.canceled) message.error(r.error ?? '导出失败')
  }

  const exportItems: MenuProps['items'] = [{ key: 'pdf', label: 'PDF', onClick: () => void handleExportPdf() }]
  const fileName = filePath ? fileBaseName(filePath) : ''

  const renderViewToggle = (label: string) => (
    <div className="detail-view-segment" role="tablist" aria-label={label}>
      {isMarkdown && showWikiIndexToggle ? (
        <button
          type="button"
          role="tab"
          aria-selected={wikiIndexView}
          className={`detail-view-segment-item detail-view-segment-item--text${wikiIndexView ? ' detail-view-segment-item--active' : ''}`}
          title="Index 视图"
          onClick={() => onWikiIndexViewChange?.(true)}
        >
          Index
        </button>
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={!wikiIndexView && viewMode === 'render'}
        className={`detail-view-segment-item${!wikiIndexView && viewMode === 'render' ? ' detail-view-segment-item--active' : ''}`}
        title="渲染预览"
        onClick={() => {
          onWikiIndexViewChange?.(false)
          onViewModeChange('render')
        }}
        dangerouslySetInnerHTML={{ __html: markdownViewIcons.render }}
      />
      <button
        type="button"
        role="tab"
        aria-selected={!wikiIndexView && viewMode === 'code'}
        className={`detail-view-segment-item${!wikiIndexView && viewMode === 'code' ? ' detail-view-segment-item--active' : ''}`}
        title="源代码"
        onClick={() => {
          onWikiIndexViewChange?.(false)
          onViewModeChange('code')
        }}
        dangerouslySetInnerHTML={{ __html: markdownViewIcons.code }}
      />
    </div>
  )

  return (
    <div className="detail-file-toolbar">
      <div className="detail-toolbar-left">
        {showWebNavigation ? (
          <div className="detail-toolbar-nav">
            <ToolbarBtn title="后退" icon={ArrowLeft} onClick={() => onNavigateBack?.()} disabled={!canGoBack} />
            <ToolbarBtn
              title="前进"
              icon={ArrowRight}
              onClick={() => onNavigateForward?.()}
              disabled={!canGoForward}
            />
            {isWebViewLoading ? (
              <ToolbarBtn title="停止加载" icon={Square} onClick={() => onStopLoading?.()} />
            ) : (
              <ToolbarBtn title="刷新" icon={RefreshCw} onClick={() => void onRefresh()} />
            )}
          </div>
        ) : null}
        {showAddressBar ? (
          <input
            ref={inputRef}
            type="text"
            className="detail-toolbar-address"
            value={addressUrl}
            placeholder="输入 http(s):// URL 并回车"
            spellCheck={false}
            onChange={(e) => onAddressChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onAddressSubmit?.()
              }
            }}
          />
        ) : null}
        {isMarkdown || isHtml ? renderViewToggle(isMarkdown ? 'Markdown 视图' : 'HTML 视图') : null}
        {!showAddressBar && !isMarkdown && !isHtml && hasFilePath ? (
          <span className="detail-toolbar-filename" title={filePath ?? undefined}>
            {fileName}
          </span>
        ) : null}
      </div>
      <div className="detail-toolbar-right">
        {showCollectToWiki && onCollectToWiki ? (
          <ToolbarBtn title="收录到 Wiki" icon={BookPlus} onClick={onCollectToWiki} />
        ) : null}
        {hasFilePath ? (
          <>
            <ToolbarBtn title="用默认编辑器打开" icon={ExternalLink} onClick={() => void handleOpenInSystem()} />
            <ToolbarBtn title="查看所在目录" icon={FolderOpen} onClick={() => void handleShowInExplorer()} />
          </>
        ) : null}
        {!showWebNavigation ? <ToolbarBtn title="刷新" icon={RefreshCw} onClick={() => void onRefresh()} /> : null}
        {isMarkdown && (
          <Dropdown menu={{ items: exportItems }} trigger={['click']}>
            <button type="button" className="detail-toolbar-btn" title="导出为..." aria-label="导出为 PDF">
              <FileDown className="detail-toolbar-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
            </button>
          </Dropdown>
        )}
        <ToolbarBtn title="关闭" icon={X} onClick={onClose} />
      </div>
    </div>
  )
}
