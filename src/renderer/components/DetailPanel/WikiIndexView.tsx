import { useEffect, useMemo, useState } from 'react'
import { List, Typography } from 'antd'
import { parseWikiIndexMarkdown, type WikiIndexEntry } from '../../../shared/wikiMarkdown'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  content: string
  wikiRootPath: string
  onOpenEntry: (relPath: string) => void
}

function groupEntries(entries: WikiIndexEntry[]): Map<string, WikiIndexEntry[]> {
  const map = new Map<string, WikiIndexEntry[]>()
  for (const e of entries) {
    const list = map.get(e.section) ?? []
    list.push(e)
    map.set(e.section, list)
  }
  return map
}

export function WikiIndexView({ content, wikiRootPath, onOpenEntry }: Props) {
  const { t } = useTypedTranslation('detailPanel')
  const entries = useMemo(() => parseWikiIndexMarkdown(content, wikiRootPath), [content, wikiRootPath])
  const groups = useMemo(() => groupEntries(entries), [entries])

  if (entries.length === 0) {
    return (
      <div className="wiki-index-view">
        <Typography.Text type="secondary">{t('wikiIndex.parseFailed')}</Typography.Text>
      </div>
    )
  }

  return (
    <div className="wiki-index-view">
      {[...groups.entries()].map(([section, items]) => (
        <section key={section} className="wiki-index-section">
          <Typography.Title level={5} style={{ marginTop: 12, marginBottom: 8 }}>
            {section}
          </Typography.Title>
          <List
            size="small"
            dataSource={items}
            renderItem={(item) => (
              <List.Item className="wiki-index-item" onClick={() => onOpenEntry(item.relPath)}>
                <div>
                  <div className="wiki-index-item-title">{item.title}</div>
                  {item.summary ? (
                    <Typography.Text type="secondary" className="wiki-index-item-summary">
                      {item.summary}
                    </Typography.Text>
                  ) : null}
                </div>
              </List.Item>
            )}
          />
        </section>
      ))}
    </div>
  )
}

export function useWikiIndexViewState(selectedFile: string | null, wikiRootPath: string) {
  const indexPath = `${wikiRootPath.replace(/\\/g, '/').replace(/^\/+/, '')}/wiki/index.md`
  const isIndex = selectedFile?.replace(/\\/g, '/') === indexPath
  const [indexView, setIndexView] = useState(false)

  useEffect(() => {
    if (!isIndex) setIndexView(false)
  }, [isIndex, selectedFile])

  return { isIndex, indexView, setIndexView, indexPath }
}
