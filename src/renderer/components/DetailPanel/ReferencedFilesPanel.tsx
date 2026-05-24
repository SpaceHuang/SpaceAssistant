import { useMemo, useState } from 'react'
import { Segmented, Typography } from 'antd'
import { useTypedSelector } from '../../hooks'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { classifyWikiReferencedPath } from '../../../shared/wikiMarkdown'
import { useDetailPanel } from './DetailPanelContext'
import { useReferencedFiles } from './useReferencedFiles'
import { ReferencedFileItem } from './ReferencedFileItem'

interface ReferencedFilesPanelProps {
  sessionId: string | null
}

type WikiFilter = 'all' | 'wiki' | 'other'

export function ReferencedFilesPanel({ sessionId }: ReferencedFilesPanelProps) {
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

  const handleFileClick = (path: string) => {
    if (path === selectedFile) return
    void openFile(path)
  }

  return (
    <div className="referenced-files-panel">
      <div className="referenced-files-header">
        <span className="referenced-files-title">引用的文件</span>
        {files.length > 0 && <span className="referenced-files-count">{visible.length}</span>}
      </div>
      {wikiEnabled && files.length > 0 ? (
        <div className="referenced-files-filter">
          <Segmented
            size="small"
            value={filter}
            onChange={(v) => setFilter(v as WikiFilter)}
            options={[
              { label: '全部', value: 'all' },
              { label: 'Wiki', value: 'wiki' },
              { label: '其他', value: 'other' }
            ]}
          />
        </div>
      ) : null}
      <div className="referenced-files-list">
        {visible.length === 0 ? (
          <div className="referenced-files-empty">
            <Typography.Text type="secondary">暂无引用的文件</Typography.Text>
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
