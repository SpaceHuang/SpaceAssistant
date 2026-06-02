import { useMemo } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ConfirmCardCollapsible } from './ConfirmCardCollapsible'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { pathBasename } from './toolCallDisplay'
import { buildUnifiedDiffLines, diffLineStats, type DiffLine } from './writeConfirmDiff'

type Props = {
  record: ToolCallRecord
  confirmMode: 'diff' | 'direct'
  onConfirm: (approved: boolean) => void
}

const DISPLAY_MAX_LINES = 500

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

function capDiffLines(lines: DiffLine[], max: number): { lines: DiffLine[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false }
  return { lines: [...lines.slice(0, max), { type: 'context', text: '…（仅显示前 500 行）' }], truncated: true }
}

export function WriteConfirmCard({ record, confirmMode, onConfirm }: Props) {
  const { oldText, newText, path } = useMemo(
    () => resolveDiffContent(record, confirmMode),
    [record, confirmMode]
  )
  const fileName = path ? pathBasename(path) : formatToolLabelFallback(record.toolName)

  const allDiffLines = useMemo(() => buildUnifiedDiffLines(oldText, newText), [oldText, newText])
  const { lines: diffLines, truncated: diffTruncated } = useMemo(
    () => capDiffLines(allDiffLines, DISPLAY_MAX_LINES),
    [allDiffLines]
  )
  const { add, remove } = useMemo(() => diffLineStats(allDiffLines), [allDiffLines])
  const hasPreview = diffLines.some((l) => l.type !== 'context' || l.text.trim().length > 0)

  const actionSummary =
    record.toolName === 'edit_file' ? `编辑「${fileName}」` : `写入「${fileName}」`

  return (
    <div className="write-confirm-card">
      <ConfirmCardDecision
        actionSummary={actionSummary}
        allowLabel="允许写入"
        denyLabel="拒绝写入"
        onConfirm={onConfirm}
        badges={
          add > 0 || remove > 0 ? (
            <>
              {add > 0 ? <span className="write-confirm-card__stat write-confirm-card__stat--add">+{add}</span> : null}
              {remove > 0 ? (
                <span className="write-confirm-card__stat write-confirm-card__stat--remove">-{remove}</span>
              ) : null}
            </>
          ) : undefined
        }
      />
      {hasPreview ? (
        <div className="write-confirm-card__body write-confirm-card__body--diff">
          <ConfirmCardCollapsible lineCount={allDiffLines.length}>
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
          </ConfirmCardCollapsible>
          {diffTruncated ? (
            <p className="write-confirm-card__preview-cap">变更超过 500 行，预览已截断；请结合文件树查看完整内容。</p>
          ) : null}
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
