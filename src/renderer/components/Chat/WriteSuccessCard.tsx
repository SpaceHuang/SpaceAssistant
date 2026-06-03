import { useMemo } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { pathBasename } from './toolCallDisplay'
import { ToolRowIcon } from './ToolRowIcon'
import { buildUnifiedDiffLines, diffLineStats } from './writeConfirmDiff'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onView?: (relPath: string) => void
}

function resolveFilePath(record: ToolCallRecord): string {
  if (record.confirmDiff?.oldPath) return record.confirmDiff.oldPath
  return typeof record.input.path === 'string' ? record.input.path : ''
}

function resolveChangeStats(record: ToolCallRecord): { add: number; remove: number } {
  if (record.confirmDiff) {
    return diffLineStats(
      buildUnifiedDiffLines(record.confirmDiff.oldContent, record.confirmDiff.newContent)
    )
  }
  if (record.toolName === 'write_file' && typeof record.input.content === 'string') {
    const content = record.input.content
    if (content === '') return { add: 0, remove: 0 }
    return { add: content.split('\n').length, remove: 0 }
  }
  return { add: 0, remove: 0 }
}

export function WriteSuccessCard({ record, onView }: Props) {
  const { t } = useTypedTranslation('chat')
  const path = useMemo(() => resolveFilePath(record), [record])
  const fileName = path ? pathBasename(path) : t('tool.fileFallback')
  const { add, remove } = useMemo(() => resolveChangeStats(record), [record])

  const handleView = () => {
    if (path && onView) onView(path)
  }

  return (
    <div className="write-success-card">
      <span className="write-success-card__icon-wrap">
        <ToolRowIcon toolName={record.toolName} />
      </span>
      <span className="write-success-card__name" title={path || fileName}>
        {fileName}
      </span>
      {add > 0 ? <span className="write-success-card__stat write-success-card__stat--add">+{add}</span> : null}
      {remove > 0 ? <span className="write-success-card__stat write-success-card__stat--remove">-{remove}</span> : null}
      {path && onView ? (
        <button type="button" className="write-success-card__view" onClick={handleView}>
          {t('tool.view')}
        </button>
      ) : null}
    </div>
  )
}
