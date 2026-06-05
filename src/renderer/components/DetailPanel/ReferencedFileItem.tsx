import { Tooltip } from 'antd'
import fileLineRaw from '../../assets/file_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'
import type { ReferencedFile } from './useReferencedFiles'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

const fileSvg = patchSvg(fileLineRaw, 14)

interface ReferencedFileItemProps {
  file: ReferencedFile
  wikiKind?: 'raw' | 'wiki' | 'schema' | null
  isActive: boolean
  onClick: () => void
}

const WIKI_BADGE_LABEL: Record<'raw' | 'wiki' | 'schema', string> = {
  raw: 'raw',
  wiki: 'Wiki',
  schema: 'Schema'
}

export function ReferencedFileItem({ file, wikiKind, isActive, onClick }: ReferencedFileItemProps) {
  const { t } = useTypedTranslation('detailPanel')
  const fileName = file.path.includes('/')
    ? file.path.slice(file.path.lastIndexOf('/') + 1)
    : file.path
  const operationLabel = file.lastOperation === 'read' ? t('fileView.read') : t('fileView.write')
  const rowTitle = `${file.path} · ${operationLabel}`

  return (
    <Tooltip title={rowTitle} mouseEnterDelay={0.45}>
      <div
        className={`referenced-file-item${isActive ? ' referenced-file-item--active' : ''}`}
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-label={rowTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
          }
        }}
      >
        <span className="referenced-file-item-icon" dangerouslySetInnerHTML={{ __html: fileSvg }} />
        <span className="referenced-file-item-name">
          {fileName}
          {wikiKind ? <span className="referenced-file-wiki-badge">{WIKI_BADGE_LABEL[wikiKind]}</span> : null}
        </span>
        <span
          className={`referenced-file-item-op referenced-file-item-op--${file.lastOperation}`}
          aria-hidden="true"
        >
          <span className="referenced-file-item-dot" />
        </span>
      </div>
    </Tooltip>
  )
}