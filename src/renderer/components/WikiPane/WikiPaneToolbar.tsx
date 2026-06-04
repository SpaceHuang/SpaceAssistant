import { Tooltip } from 'antd'
import folderOpenLineRaw from '../../assets/folder_open_line.svg?raw'
import refresh2LineRaw from '../../assets/refresh_2_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

const folderOpenSvg = patchSvg(folderOpenLineRaw, 14)
const refreshSvg = patchSvg(refresh2LineRaw, 14)

type Props = {
  onOpen: () => void
  onRefresh: () => void
  showOpen?: boolean
  refreshDisabled?: boolean
}

export function WikiPaneToolbar({ onOpen, onRefresh, showOpen = true, refreshDisabled = false }: Props) {
  const { t } = useTypedTranslation('wiki')
  return (
    <div className="sa-pane-toolbar">
      {showOpen ? (
        <Tooltip title={t('toolbar.openInExplorer')}>
          <button
            type="button"
            className="sa-icon-btn sa-icon-btn--xs"
            onClick={onOpen}
            aria-label={t('toolbar.openInExplorer')}
            data-testid="wiki-open-btn"
            dangerouslySetInnerHTML={{ __html: folderOpenSvg }}
          />
        </Tooltip>
      ) : null}
      <Tooltip title={t('toolbar.refresh')}>
        <button
          type="button"
          className="sa-icon-btn sa-icon-btn--xs"
          onClick={onRefresh}
          disabled={refreshDisabled}
          aria-label={t('toolbar.refresh')}
          data-testid="wiki-refresh-btn"
          dangerouslySetInnerHTML={{ __html: refreshSvg }}
        />
      </Tooltip>
    </div>
  )
}
