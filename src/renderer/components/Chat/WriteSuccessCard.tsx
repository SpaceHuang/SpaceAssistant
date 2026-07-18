import { useMemo } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ArtifactContainer, ArtifactRole } from '../../../shared/artifactTypes'
import { pathBasename } from './toolCallDisplay'
import { ToolRowIcon } from './ToolRowIcon'
import { buildUnifiedDiffLines, diffLineStats } from './writeConfirmDiff'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onView?: (relPath: string) => void
}

type ArtifactWriteMeta = {
  container?: ArtifactContainer
  role?: ArtifactRole
  finalPath?: string
  reason?: string
}

function resolveFilePath(record: ToolCallRecord): string {
  const meta = readArtifactMeta(record)
  if (meta.finalPath) return meta.finalPath
  if (record.confirmDiff?.oldPath) return record.confirmDiff.oldPath
  return typeof record.input.path === 'string' ? record.input.path : ''
}

function readArtifactMeta(record: ToolCallRecord): ArtifactWriteMeta {
  const data = record.result?.data
  if (!data || typeof data !== 'object') return {}
  const meta = data as Record<string, unknown>
  return {
    container: typeof meta.container === 'string' ? (meta.container as ArtifactContainer) : undefined,
    role: typeof meta.role === 'string' ? (meta.role as ArtifactRole) : undefined,
    finalPath: typeof meta.finalPath === 'string' ? meta.finalPath : undefined,
    reason: typeof meta.reason === 'string' ? meta.reason : undefined
  }
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

export function resolveArtifactBadgeLabel(
  meta: ArtifactWriteMeta,
  t: (key: 'writeSuccess.badgeProject' | 'writeSuccess.badgePackage' | 'writeSuccess.badgeScratch' | 'writeSuccess.badgeSupporting' | 'writeSuccess.badgeReference') => string
): string | null {
  if (meta.container === 'project') return t('writeSuccess.badgeProject')
  if (meta.container === 'scratch') return t('writeSuccess.badgeScratch')
  if (meta.role === 'supporting') return t('writeSuccess.badgeSupporting')
  if (meta.role === 'reference') return t('writeSuccess.badgeReference')
  if (meta.container === 'package') return t('writeSuccess.badgePackage')
  return null
}

export function WriteSuccessCard({ record, onView }: Props) {
  const { t } = useTypedTranslation('chat')
  const meta = useMemo(() => readArtifactMeta(record), [record])
  const path = useMemo(() => resolveFilePath(record), [record, meta.finalPath])
  const fileName = path ? pathBasename(path) : t('tool.fileFallback')
  const { add, remove } = useMemo(() => resolveChangeStats(record), [record])
  const badge = useMemo(() => resolveArtifactBadgeLabel(meta, t), [meta, t])

  const handleView = () => {
    if (path && onView) onView(path)
  }

  return (
    <div className="write-success-card">
      <span className="write-success-card__icon-wrap">
        <ToolRowIcon toolName={record.toolName} />
      </span>
      {badge ? <span className="write-success-card__badge">{badge}</span> : null}
      <span className="write-success-card__name" title={path || fileName}>
        {fileName}
      </span>
      {path ? <span className="write-success-card__path">{path}</span> : null}
      {meta.reason ? <span className="write-success-card__reason">{meta.reason}</span> : null}
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
