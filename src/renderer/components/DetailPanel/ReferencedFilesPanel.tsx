import { useMemo, useState } from 'react'
import { Typography } from 'antd'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { classifyWikiReferencedPath } from '../../../shared/wikiMarkdown'
import { useDetailPanel } from './DetailPanelContext'
import { useReferencedFiles } from './useReferencedFiles'
import { ReferencedFileItem } from './ReferencedFileItem'
import { isUnderWikiRoot, requestFilePaneSelect } from '../../services/filePaneNavigation'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

interface ReferencedFilesPanelProps {
  sessionId: string | null
}

type WikiFilter = 'all' | 'wiki' | 'other'

export function ReferencedFilesPanel({ sessionId }: ReferencedFilesPanelProps) {
  const { t } = useTypedTranslation('detailPanel')
  const files = useReferencedFiles(sessionId)
  const { selectedFile, openFile } = useDetailPanel()
  const wikiRoot = useTypedSelector((s) => s.config.config?.wiki?.rootPath ?? DEFAULT_WIKI_CONFIG.rootPath)
  const wikiEnabled = useTypedSelector((s) => s.config.config?.wiki?.enabled ?? false)
  const [filter, setFilter] = useState<WikiFilter>('all')

  const enriched = useMemo(
    () =>
      files.map((file) => ({
        ...file,
        wikiKind: wikiEnabled ? classifyWikiReferencedPath(file.path, wikiRoot) : null
      })),
    [files, wikiEnabled, wikiRoot]
  )

  const visible = useMemo(() => {
    if (filter === 'wiki') return enriched.filter((f) => f.wikiKind === 'wiki' || f.wikiKind === 'raw' || f.wikiKind === 'schema')
    if (filter === 'other') return enriched.filter((f) => !f.wikiKind)
    return enriched
  }, [enriched, filter])

  const filterOptions = useMemo(
    () =>
      [
        { value: 'all' as const, label: t('referencedFiles.filterAll') },
        { value: 'wiki' as const, label: t('referencedFiles.filterWiki') },
        { value: 'other' as const, label: t('referencedFiles.filterOther') }
      ],
    [t]
  )

  const handleFileClick = (path: string) => {
    if (path === selectedFile) return
    const preferWiki = wikiEnabled && isUnderWikiRoot(path, wikiRoot)
    requestFilePaneSelect({ relPath: path, preferWiki: preferWiki || undefined })
    void openFile(path)
  }

  return (
    <div className="referenced-files-panel">
      <div className="detail-panel-section-header referenced-files-header">
        <span className="detail-panel-section-title">{t('referencedFiles.title')}</span>
        {files.length > 0 ? <span className="detail-panel-section-badge">{visible.length}</span> : null}
      </div>
      {wikiEnabled && files.length > 0 ? (
        <div className="referenced-files-filter">
          <div className="referenced-files-segment" role="tablist" aria-label={t('referencedFiles.title')}>
            {filterOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={filter === option.value}
                className={[
                  'referenced-files-segment__item',
                  filter === option.value ? 'referenced-files-segment__item--active' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="referenced-files-list">
        {visible.length === 0 ? (
          <div className="referenced-files-empty">
            <Typography.Text type="secondary">{t('referencedFiles.empty')}</Typography.Text>
          </div>
        ) : (
          visible.map((file) => (
            <ReferencedFileItem
              key={file.path}
              file={file}
              wikiKind={file.wikiKind}
              isActive={file.path === selectedFile}
              onClick={() => handleFileClick(file.path)}
            />
          ))
        )}
      </div>
    </div>
  )
}
