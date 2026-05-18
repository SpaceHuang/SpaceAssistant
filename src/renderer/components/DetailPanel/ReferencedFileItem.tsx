import { Tooltip } from 'antd'
import fileLineRaw from '../../assets/file_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'
import type { ReferencedFile } from './useReferencedFiles'

const fileSvg = patchSvg(fileLineRaw, 14)

interface ReferencedFileItemProps {
  file: ReferencedFile
  isActive: boolean
  onClick: () => void
}

export function ReferencedFileItem({ file, isActive, onClick }: ReferencedFileItemProps) {
  const fileName = file.path.includes('/')
    ? file.path.slice(file.path.lastIndexOf('/') + 1)
    : file.path

  return (
    <div
      className={`referenced-file-item${isActive ? ' referenced-file-item--active' : ''}`}
      onClick={onClick}
    >
      <span className="referenced-file-item-icon" dangerouslySetInnerHTML={{ __html: fileSvg }} />
      <div className="referenced-file-item-info">
        <Tooltip title={file.path} mouseEnterDelay={0.5}>
          <span className="referenced-file-item-name">{fileName}</span>
        </Tooltip>
        <Tooltip title={file.path} mouseEnterDelay={0.5}>
          <span className="referenced-file-item-path">{file.path}</span>
        </Tooltip>
      </div>
      <span className={`referenced-file-item-op referenced-file-item-op--${file.lastOperation}`}>
        <span className="referenced-file-item-dot" />
        {file.lastOperation === 'read' ? '读取' : '写入'}
      </span>
    </div>
  )
}