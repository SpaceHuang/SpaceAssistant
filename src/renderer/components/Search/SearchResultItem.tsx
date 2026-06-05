import type { SearchResult } from '../../../shared/domainTypes'
import { patchSvg } from '../../utils/patchSvg'
import { getFileSearchDisplay, getSessionAuxiliaryText } from './searchResultUtils'
import chatIconRaw from '../../assets/chat_3_line.svg?raw'
import fileIconRaw from '../../assets/file_line.svg?raw'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import './search.css'

const chatIconSvg = patchSvg(chatIconRaw, 14)
const fileIconSvg = patchSvg(fileIconRaw, 14)

type Props = {
  item: SearchResult
  onClick: () => void
}

export function SearchResultItem({ item, onClick }: Props) {
  const { t } = useTypedTranslation('common')
  const isSession = item.type === 'session'
  const iconSvg = isSession ? chatIconSvg : fileIconSvg
  const tagLabel = isSession ? t('search.tagChat') : t('search.tagFile')

  const fileDisplay = !isSession ? getFileSearchDisplay(item) : null
  const sessionAuxiliary = isSession ? getSessionAuxiliaryText(item) : null

  const primaryTitle = fileDisplay?.fileName ?? item.title
  const detailLine = fileDisplay
    ? fileDisplay.detailLine
    : sessionAuxiliary
      ? sessionAuxiliary
      : item.preview.trim() || null

  const tooltipParts = fileDisplay
    ? [fileDisplay.fullPath, fileDisplay.detailLine && fileDisplay.detailLine !== fileDisplay.fullPath ? fileDisplay.detailLine : null]
    : [item.title, sessionAuxiliary, item.preview.trim() || null]

  return (
    <div
      className="search-result-item"
      role="button"
      tabIndex={0}
      title={tooltipParts.filter(Boolean).join(' · ')}
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
          <span className="search-result-item__title">{primaryTitle}</span>
          <span className={`search-result-item__type search-result-item__type--${item.type}`}>{tagLabel}</span>
        </div>
        {detailLine ? <span className="search-result-item__detail">{detailLine}</span> : null}
      </div>
    </div>
  )
}
