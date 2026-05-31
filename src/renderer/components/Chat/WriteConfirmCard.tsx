import { useMemo } from 'react'
import { Check, FileCode, FileText, Hash, X } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { pathBasename } from './toolCallDisplay'
import { buildUnifiedDiffLines, diffLineStats, type DiffLine } from './writeConfirmDiff'

type Props = {
  record: ToolCallRecord
  confirmMode: 'diff' | 'direct'
  onConfirm: (approved: boolean) => void
}

const PREVIEW_MAX_LINES = 120

function fileIconForName(name: string) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext === 'css' || ext === 'scss' || ext === 'less') return Hash
  if (['ts', 'tsx', 'js', 'jsx', 'vue', 'py', 'go', 'rs'].includes(ext)) return FileCode
  return FileText
}

function resolveDiffContent(record: ToolCallRecord, confirmMode: 'diff' | 'direct'): { oldText: string; newText: string; path: string } {
  const path =
    record.confirmDiff?.oldPath ??
    (typeof record.input.path === 'string' ? record.input.path : '') ??
    ''
  if (record.confirmDiff) {
    return {
      path,
      oldText: record.confirmDiff.oldContent,
      newText: record.confirmDiff.newContent
    }
  }
  if (record.toolName === 'write_file' && typeof record.input.content === 'string') {
    return { path, oldText: '', newText: record.input.content }
  }
  if (confirmMode === 'direct' && typeof record.input.path === 'string') {
    return { path: record.input.path, oldText: '', newText: '' }
  }
  return { path, oldText: '', newText: '' }
}

function truncateDiffLines(lines: DiffLine[], max: number): DiffLine[] {
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), { type: 'context', text: '…' }]
}

export function WriteConfirmCard({ record, confirmMode, onConfirm }: Props) {
  const { oldText, newText, path } = useMemo(
    () => resolveDiffContent(record, confirmMode),
    [record, confirmMode]
  )
  const fileName = path ? pathBasename(path) : formatToolLabelFallback(record.toolName)
  const FileIcon = fileIconForName(fileName)

  const diffLines = useMemo(() => truncateDiffLines(buildUnifiedDiffLines(oldText, newText), PREVIEW_MAX_LINES), [oldText, newText])
  const { add, remove } = useMemo(() => diffLineStats(diffLines), [diffLines])
  const hasPreview = diffLines.some((l) => l.type !== 'context' || l.text.trim().length > 0)

  return (
    <div className="write-confirm-card">
      <div className="write-confirm-card__header">
        <span className="write-confirm-card__icon-badge" aria-hidden>
          <FileIcon size={14} strokeWidth={1.75} className="write-confirm-card__file-icon" />
        </span>
        <span className="write-confirm-card__filename" title={path || fileName}>
          {fileName}
        </span>
        {add > 0 ? <span className="write-confirm-card__stat write-confirm-card__stat--add">+{add}</span> : null}
        {remove > 0 ? <span className="write-confirm-card__stat write-confirm-card__stat--remove">-{remove}</span> : null}
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            aria-label="允许"
            title="允许"
            onClick={() => onConfirm(true)}
          >
            <Check size={16} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            aria-label="拒绝"
            title="拒绝"
            onClick={() => onConfirm(false)}
          >
            <X size={16} strokeWidth={2.25} />
          </button>
        </div>
      </div>
      {hasPreview ? (
        <div className="write-confirm-card__body">
          <pre className="write-confirm-card__code">
            {diffLines.map((line, i) => (
              <div
                key={`${line.type}-${i}`}
                className={[
                  'write-confirm-card__line',
                  line.type === 'add' ? 'write-confirm-card__line--add' : '',
                  line.type === 'remove' ? 'write-confirm-card__line--remove' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {line.text || ' '}
              </div>
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function formatToolLabelFallback(toolName: string): string {
  if (toolName === 'write_file') return '写入文件'
  if (toolName === 'edit_file') return '编辑文件'
  return toolName
}
