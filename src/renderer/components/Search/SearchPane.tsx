import { useState } from 'react'
import { Input } from 'antd'
import type { SearchResult } from '../../../shared/domainTypes'
import { SearchResultItem } from './SearchResultItem'
import './search.css'

type Props = {
  onSessionResultClick: (sessionId: string, messageId: string) => void
  onFileResultClick: (relPath: string) => void
}

export function SearchPane({ onSessionResultClick, onFileResultClick }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])

  const run = async () => {
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
      <Input.Search placeholder="搜索聊天与文本文件" value={q} onChange={(e) => setQ(e.target.value)} onSearch={run} />
      <div className="session-list-scroll">
        {results.map((item) => (
          <SearchResultItem key={item.id} item={item} onClick={() => handleClick(item)} />
        ))}
      </div>
    </div>
  )
}
