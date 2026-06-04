import { App, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { renderToStaticMarkup } from 'react-dom/server'
import { BookPlus, ExternalLink, FileDown, FolderOpen, RefreshCw, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { FileTypeCategory } from '../../../shared/fileTypes'
import type { ViewMode } from './DetailPanelContext'
import { MarkdownRenderView } from './MarkdownRenderView'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
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

function ToolbarBtn({ title, icon: Icon, onClick }: { title: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button type="button" className="detail-toolbar-btn" title={title} aria-label={title} onClick={onClick}>
      <Icon className="detail-toolbar-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
    </button>
  )
}

type Props = {
  filePath: string
  fileType: FileTypeCategory
  viewMode: ViewMode
  previewContent: string | null
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
  filePath,
  fileType,
  viewMode,
  previewContent,
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
  const { t } = useTypedTranslation('detailPanel')
  const isMarkdown = fileType === 'markdown'

  const handleOpenInSystem = async () => {
    const r = await window.api.fileOpenInSystem(filePath)
    if (!r.ok) message.error(r.error ?? t('toolbar.openFailed'))
  }

  const handleShowInExplorer = async () => {
    const r = await window.api.fileShowInExplorer(filePath)
    if (!r.ok) message.error(r.error ?? t('toolbar.openDirFailed'))
  }

  const handleExportPdf = async () => {
    if (!previewContent) return
    const html = renderToStaticMarkup(<MarkdownRenderView content={previewContent} />)
    const r = await window.api.fileExportPdf({ htmlContent: html, defaultPath: filePath })
    if (r.ok) message.success(`${t('toolbar.exportedTo')} ${r.path}`)
    else if (!r.canceled) message.error(r.error ?? t('toolbar.exportFailed'))
  }

  const exportItems: MenuProps['items'] = [{ key: 'pdf', label: 'PDF', onClick: () => void handleExportPdf() }]
  const fileName = fileBaseName(filePath)

  return (
    <div className="detail-file-toolbar">
      <div className="detail-toolbar-left">
        {isMarkdown ? (
          <div className="detail-view-segment" role="tablist" aria-label={t('toolbar.markdownView')}>
            {showWikiIndexToggle ? (
              <button
                type="button"
                role="tab"
                aria-selected={wikiIndexView}
                className={`detail-view-segment-item detail-view-segment-item--text${wikiIndexView ? ' detail-view-segment-item--active' : ''}`}
                title={t('toolbar.indexView')}
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
              title={t('toolbar.renderPreview')}
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
              title={t('toolbar.sourceCode')}
              onClick={() => {
                onWikiIndexViewChange?.(false)
                onViewModeChange('code')
              }}
              dangerouslySetInnerHTML={{ __html: markdownViewIcons.code }}
            />
          </div>
        ) : (
          <span className="detail-toolbar-filename" title={filePath}>
            {fileName}
          </span>
        )}
      </div>
      <div className="detail-toolbar-right">
        {showCollectToWiki && onCollectToWiki ? (
          <ToolbarBtn title={t('toolbar.collectToWiki')} icon={BookPlus} onClick={onCollectToWiki} />
        ) : null}
        <ToolbarBtn title={t('toolbar.openInDefaultEditor')} icon={ExternalLink} onClick={() => void handleOpenInSystem()} />
        <ToolbarBtn title={t('toolbar.showInFolder')} icon={FolderOpen} onClick={() => void handleShowInExplorer()} />
        <ToolbarBtn title={t('toolbar.refresh')} icon={RefreshCw} onClick={() => void onRefresh()} />
        {isMarkdown && (
          <Dropdown menu={{ items: exportItems }} trigger={['click']}>
            <button type="button" className="detail-toolbar-btn" title={t('toolbar.exportAs')} aria-label={t('toolbar.exportAs')}>
              <FileDown className="detail-toolbar-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
            </button>
          </Dropdown>
        )}
        <ToolbarBtn title={t('toolbar.close')} icon={X} onClick={onClose} />
      </div>
    </div>
  )
}
