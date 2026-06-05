import newFolderLineRaw from '../../assets/new_folder_line.svg?raw'
import refresh2LineRaw from '../../assets/refresh_2_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

const newFolderSvg = patchSvg(newFolderLineRaw, 14)
const refreshSvg = patchSvg(refresh2LineRaw, 14)

interface FileTreeToolbarProps {
  onNewDirectory: () => void
  onRefresh: () => void
}

export function FileTreeToolbar({ onNewDirectory, onRefresh }: FileTreeToolbarProps) {
  const { t } = useTypedTranslation('fileTree')
  const newDirectoryLabel = t('toolbar.newDirectory')
  const refreshLabel = t('toolbar.refresh')

  return (
    <div className="sa-pane-toolbar">
      <button
        type="button"
        className="sa-icon-btn sa-icon-btn--xs"
        onClick={onNewDirectory}
        title={newDirectoryLabel}
        aria-label={newDirectoryLabel}
        dangerouslySetInnerHTML={{ __html: newFolderSvg }}
        data-testid="new-directory-btn"
      />
      <button
        type="button"
        className="sa-icon-btn sa-icon-btn--xs"
        onClick={onRefresh}
        title={refreshLabel}
        aria-label={refreshLabel}
        dangerouslySetInnerHTML={{ __html: refreshSvg }}
        data-testid="refresh-btn"
      />
    </div>
  )
}
