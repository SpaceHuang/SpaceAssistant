import type { ToolCallRecord } from '../../../shared/domainTypes'
import { normalizeViewerUrl } from '../../../shared/viewerUrl'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import { summarizeBrowserConfirmInput } from './browserConfirmDisplay'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: (approved: boolean) => void
}

export function BrowserConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const { openUrl } = useDetailPanel()
  const summary = summarizeBrowserConfirmInput(record.input)
  if (!summary) return null

  const urlValue = summary.detailLabel === 'URL' ? summary.detailValue : ''
  const canOpenInViewer = Boolean(urlValue && urlValue !== '(未指定 URL)' && normalizeViewerUrl(urlValue))

  const handleOpenInViewer = () => {
    if (!canOpenInViewer) return
    void openUrl(urlValue)
  }

  return (
    <div className="write-confirm-card browser-confirm-card">
      <ConfirmCardDecision
        actionSummary={summary.headline}
        allowLabel={t('confirm.browser.allow')}
        denyLabel={t('confirm.browser.deny')}
        onConfirm={onConfirm}
      />
      <div className="write-confirm-card__detail browser-confirm-card__detail">
        {canOpenInViewer ? (
          <button
            type="button"
            className="write-confirm-card__command browser-confirm-card__url browser-confirm-card__url-link"
            title={`在内容查看器中打开：${urlValue}`}
            onClick={handleOpenInViewer}
          >
            {urlValue}
          </button>
        ) : (
          <p className="write-confirm-card__command browser-confirm-card__url" title={summary.detailValue}>
            {summary.detailValue}
          </p>
        )}
        {summary.hint ? <p className="write-confirm-card__note browser-confirm-card__hint">{summary.hint}</p> : null}
      </div>
    </div>
  )
}
