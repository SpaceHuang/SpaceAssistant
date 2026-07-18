import { useMemo, useState } from 'react'
import type { ArtifactApiItem } from '../../../shared/api'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { SessionArtifactsCleanAction } from './SessionArtifactsCleanAction'

type Props = {
  sessionId: string | null
  workDir: string
  artifacts: ArtifactApiItem[]
  onOpen: (relPath: string) => void
  onDelete?: (artifactId: string) => void
  onRelocate?: (artifact: ArtifactApiItem) => void
}

type ArtifactGroup = {
  key: string
  title: string
  defaultExpanded: boolean
  items: ArtifactApiItem[]
}

function toDisplayPath(workDir: string, finalPath: string): string {
  if (!workDir || !finalPath.startsWith(workDir)) return finalPath.replace(/\\/g, '/')
  const relative = finalPath.slice(workDir.length).replace(/^[/\\]+/, '')
  return relative.replace(/\\/g, '/')
}

type DetailPanelLabelKey =
  | 'sessionArtifacts.groupProject'
  | 'sessionArtifacts.groupPackage'
  | 'sessionArtifacts.groupScratch'
  | 'sessionArtifacts.groupReference'

export function groupSessionArtifacts(
  artifacts: ArtifactApiItem[],
  t: (key: DetailPanelLabelKey) => string
): ArtifactGroup[] {
  const project = artifacts.filter((item) => item.container === 'project')
  const packages = artifacts.filter((item) => item.container === 'package')
  const scratch = artifacts.filter((item) => item.container === 'scratch')
  const references = artifacts.filter((item) => item.role === 'reference' && item.container !== 'package')

  const packageGroups = new Map<string, ArtifactApiItem[]>()
  for (const item of packages) {
    const key = item.packageId ?? item.id
    const group = packageGroups.get(key) ?? []
    group.push(item)
    packageGroups.set(key, group)
  }

  const groups: ArtifactGroup[] = []
  if (project.length > 0) {
    groups.push({ key: 'project', title: t('sessionArtifacts.groupProject'), defaultExpanded: true, items: project })
  }
  for (const [key, items] of packageGroups) {
    groups.push({
      key: `package-${key}`,
      title: t('sessionArtifacts.groupPackage'),
      defaultExpanded: true,
      items
    })
  }
  if (references.length > 0) {
    groups.push({ key: 'reference', title: t('sessionArtifacts.groupReference'), defaultExpanded: true, items: references })
  }
  if (scratch.length > 0) {
    groups.push({ key: 'scratch', title: t('sessionArtifacts.groupScratch'), defaultExpanded: false, items: scratch })
  }
  return groups
}

export function SessionArtifactsPanel({ sessionId, workDir, artifacts, onOpen, onDelete, onRelocate }: Props) {
  const { t } = useTypedTranslation('detailPanel')
  const groups = useMemo(() => groupSessionArtifacts(artifacts, t), [artifacts, t])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const isExpanded = (group: ArtifactGroup) => expanded[group.key] ?? group.defaultExpanded

  if (!sessionId) return null

  const hasScratch = artifacts.some((item) => item.container === 'scratch' || item.role === 'scratch')

  return (
    <div className="session-artifacts-panel">
      <div className="detail-panel-section-header">
        <span className="detail-panel-section-title">{t('sessionArtifacts.title')}</span>
        {artifacts.length > 0 ? <span className="detail-panel-section-badge">{artifacts.length}</span> : null}
        {hasScratch ? <SessionArtifactsCleanAction sessionId={sessionId} /> : null}
      </div>
      {groups.length === 0 ? <div className="session-artifacts-panel__empty">{t('sessionArtifacts.empty')}</div> : null}
      {groups.map((group) => (
        <div key={group.key} className="session-artifacts-group">
          <button
            type="button"
            className="session-artifacts-group__header"
            aria-expanded={isExpanded(group)}
            onClick={() => setExpanded((state) => ({ ...state, [group.key]: !isExpanded(group) }))}
          >
            {group.title}
          </button>
          {isExpanded(group)
            ? group.items.map((item) => {
                const relPath = toDisplayPath(workDir, item.finalPath)
                return (
                  <div key={item.id} className="session-artifacts-item">
                    <button type="button" className="session-artifacts-item__open" onClick={() => onOpen(relPath)}>
                      {item.title || relPath}
                    </button>
                    <span className="session-artifacts-item__path">{relPath}</span>
                    {item.stage ? <span className="session-artifacts-item__stage">{item.stage}</span> : null}
                    {onDelete && (item.container === 'scratch' || item.role === 'scratch') ? (
                      <button type="button" className="session-artifacts-item__delete" onClick={() => onDelete(item.id)}>
                        {t('sessionArtifacts.delete')}
                      </button>
                    ) : null}
                    {onRelocate && item.status === 'active' ? (
                      <button type="button" className="session-artifacts-item__relocate" onClick={() => onRelocate(item)}>
                        {t('sessionArtifacts.relocate')}
                      </button>
                    ) : null}
                  </div>
                )
              })
            : null}
        </div>
      ))}
    </div>
  )
}
