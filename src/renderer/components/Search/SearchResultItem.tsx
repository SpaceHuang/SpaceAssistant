import { Tag, Typography } from 'antd'
import type { SearchResult } from '../../../shared/domainTypes'
import { patchSvg } from '../../utils/patchSvg'
import { getFileAuxiliaryText, getSessionAuxiliaryText } from './searchResultUtils'
import chatIconRaw from '../../assets/chat_3_line.svg?raw'
import fileIconRaw from '../../assets/file_line.svg?raw'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './search.css'

const { Text } = Typography

const chatIconSvg = patchSvg(chatIconRaw, 16)
const fileIconSvg = patchSvg(fileIconRaw, 16)

type Props = {
  item: SearchResult
  onClick: () => void
}

export function SearchResultItem({ item, onClick }: Props) {
  const { t } = useTypedTranslation('common')
  const isSession = item.type === 'session'
  const iconSvg = isSession ? chatIconSvg : fileIconSvg
  const tagLabel = isSession ? t('search.tagChat') : t('search.tagFile')
  const tagColor = isSession ? 'blue' : 'green'
  const auxiliaryText = isSession ? getSessionAuxiliaryText(item) : getFileAuxiliaryText(item)
  const auxiliaryPrefix = isSession ? '📁' : '📂'

  return (
    <div
      className="search-result-item"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <span className="search-result-item__icon" aria-hidden dangerouslySetInnerHTML={{ __html: iconSvg }} />
      <div className="search-result-item__body">
        <div className="search-result-item__title-row">
          <span className="search-result-item__title" title={item.title}>
            {item.title}
          </span>
          <Tag className="search-result-item__tag" color={tagColor}>
            {tagLabel}
          </Tag>
        </div>
        {auxiliaryText ? (
          <Text type="secondary" className="search-result-item__aux">
            {auxiliaryPrefix} {auxiliaryText}
          </Text>
        ) : null}
        <Text type="secondary" className="search-result-item__preview">
          {item.preview}
        </Text>
      </div>
    </div>
  )
}
