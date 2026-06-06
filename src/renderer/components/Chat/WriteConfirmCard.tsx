import { useMemo } from 'react'
import type { FileConfirmMode, ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { ConfirmCardCollapsible } from './ConfirmCardCollapsible'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { pathBasename } from './toolCallDisplay'
import { buildUnifiedDiffLines, diffLineStats, type DiffLine } from './writeConfirmDiff'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  confirmMode: FileConfirmMode
  onConfirm: ToolConfirmHandler
}

const DISPLAY_MAX_LINES = 500

function resolveDiffContent(record: ToolCallRecord, confirmMode: FileConfirmMode): { oldText: string; newText: string; path: string } {
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
  if (confirmMode === 'direct' && !record.confirmDiff && typeof record.input.path === 'string') {
    return { path: record.input.path, oldText: '', newText: '' }
  }
  return { path, oldText: '', newText: '' }
}

function capDiffLines(lines: DiffLine[], max: number, truncatedLine: string): { lines: DiffLine[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false }
  return { lines: [...lines.slice(0, max), { type: 'context', text: truncatedLine }], truncated: true }
}

export function WriteConfirmCard({ record, confirmMode, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')

  const { oldText, newText, path } = useMemo(
    () => resolveDiffContent(record, confirmMode),
    [record, confirmMode]
  )
  const fileName = path ? pathBasename(path) : formatToolLabelFallback(record.toolName, t)

  const allDiffLines = useMemo(() => buildUnifiedDiffLines(oldText, newText), [oldText, newText])
  const { lines: diffLines, truncated: diffTruncated } = useMemo(
    () => capDiffLines(allDiffLines, DISPLAY_MAX_LINES, t('confirm.previewTruncatedLine')),
    [allDiffLines, t]
  )
  const { add, remove } = useMemo(() => diffLineStats(allDiffLines), [allDiffLines])
  const hasPreview = diffLines.some((l) => l.type !== 'context' || l.text.trim().length > 0)

  const actionSummary =
    record.toolName === 'edit_file'
      ? t('confirm.write.editAction', { fileName })
      : t('confirm.write.writeAction', { fileName })

  const fallback = record.autoApproveFallback

  return (
    <div className="write-confirm-card">
      {fallback ? (
        <div className="write-confirm-card__fallback-banner" role="status">
          {t('fileAutoApprove.fallbackBanner', { reason: fallback.reason })}
        </div>
      ) : null}
      <ConfirmCardDecision
        actionSummary={actionSummary}
        allowLabel={t('confirm.write.allow')}
        denyLabel={t('confirm.write.deny')}
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
      >
        {hasPreview ? (
          <div className="write-confirm-card__subject write-confirm-card__subject--diff">
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
              {diffTruncated ? <p className="write-confirm-card__subject-note">{t('confirm.previewCap')}</p> : null}
            </div>
          </div>
        ) : null}
      </ConfirmCardDecision>
    </div>
  )
}

function formatToolLabelFallback(toolName: string, t: (key: 'confirm.write.writeFileFallback' | 'confirm.write.editFileFallback') => string): string {
  if (toolName === 'write_file') return t('confirm.write.writeFileFallback')
  if (toolName === 'edit_file') return t('confirm.write.editFileFallback')
  return toolName
}
