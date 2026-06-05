import { useState } from 'react'
import { Empty, Input } from 'antd'
import type { SearchResult } from '../../../shared/domainTypes'
import { SearchResultItem } from './SearchResultItem'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './search.css'

type Props = {
  onSessionResultClick: (sessionId: string, messageId: string) => void
  onFileResultClick: (relPath: string) => void
}

export function SearchPane({ onSessionResultClick, onFileResultClick }: Props) {
  const { t } = useTypedTranslation('common')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)

  const run = async () => {
    setSearched(true)
    const rows = await window.api.searchExecute(q)
    setResults(rows)
  }

  const handleClick = (item: SearchResult) => {
    if (item.type === 'session' && item.sessionId && item.messageId) {
      onSessionResultClick(item.sessionId, item.messageId)
      return
    }
    if (item.type === 'file' && item.path) {
      onFileResultClick(item.path)
    }
  }

  return (
    <div className="sider-pane">
      <Input.Search
        placeholder={t('search.placeholder')}
        aria-label={t('search.searchAria')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onSearch={run}
      />
      <div className="session-list-scroll">
        {results.length === 0 ? (
          <Empty
            className="search-pane-empty"
            description={searched ? t('search.emptyNoResults') : t('search.emptyHint')}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          results.map((item) => <SearchResultItem key={item.id} item={item} onClick={() => handleClick(item)} />)
        )}
      </div>
    </div>
  )
}
