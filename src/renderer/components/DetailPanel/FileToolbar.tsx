import { App, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalLink, FileDown, FolderOpen, RefreshCw, X } from 'lucide-react'
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

function ToolbarBtn({ title, icon: Icon, onClick }: { title: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button type="button" className="detail-toolbar-btn" title={title} onClick={onClick}>
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
  onPendingPlanClick?: () => void
}

export function FileToolbar({
  filePath,
  fileType,
  viewMode,
  previewContent,
  onViewModeChange,
  onClose,
  onRefresh,
  onPendingPlanClick
}: Props) {
  const { message } = App.useApp()
  const isMarkdown = fileType === 'markdown'

  const handleOpenInSystem = async () => {
    const r = await window.api.fileOpenInSystem(filePath)
    if (!r.ok) message.error(r.error ?? '打开失败')
  }

  const handleShowInExplorer = async () => {
    const r = await window.api.fileShowInExplorer(filePath)
    if (!r.ok) message.error(r.error ?? '打开目录失败')
  }

  const handleExportPdf = async () => {
    if (!previewContent) return
    const html = renderToStaticMarkup(<MarkdownRenderView content={previewContent} />)
    const r = await window.api.fileExportPdf({ htmlContent: html, defaultPath: filePath })
    if (r.ok) message.success(`已导出至 ${r.path}`)
    else if (!r.canceled) message.error(r.error ?? '导出失败')
  }

  const exportItems: MenuProps['items'] = [{ key: 'pdf', label: 'PDF', onClick: () => void handleExportPdf() }]

  return (
    <div className="detail-file-toolbar">
      <div className="detail-toolbar-left">
        {isMarkdown && (
          <div className="detail-view-segment" role="tablist" aria-label="Markdown 视图">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'render'}
              className={`detail-view-segment-item${viewMode === 'render' ? ' detail-view-segment-item--active' : ''}`}
              title="渲染预览"
              onClick={() => onViewModeChange('render')}
              dangerouslySetInnerHTML={{ __html: markdownViewIcons.render }}
            />
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'code'}
              className={`detail-view-segment-item${viewMode === 'code' ? ' detail-view-segment-item--active' : ''}`}
              title="源代码"
              onClick={() => onViewModeChange('code')}
              dangerouslySetInnerHTML={{ __html: markdownViewIcons.code }}
            />
          </div>
        )}
      </div>
      <div className="detail-toolbar-right">
        {onPendingPlanClick ? (
          <button type="button" className="detail-toolbar-text-btn" onClick={onPendingPlanClick}>
            计划待审批
          </button>
        ) : null}
        <ToolbarBtn title="用默认编辑器打开" icon={ExternalLink} onClick={() => void handleOpenInSystem()} />
        <ToolbarBtn title="查看所在目录" icon={FolderOpen} onClick={() => void handleShowInExplorer()} />
        <ToolbarBtn title="刷新" icon={RefreshCw} onClick={() => void onRefresh()} />
        {isMarkdown && (
          <Dropdown menu={{ items: exportItems }} trigger={['click']}>
            <button type="button" className="detail-toolbar-btn" title="导出为...">
              <FileDown className="detail-toolbar-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden />
            </button>
          </Dropdown>
        )}
        <ToolbarBtn title="关闭" icon={X} onClick={onClose} />
      </div>
    </div>
  )
}
