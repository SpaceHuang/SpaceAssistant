import { useMemo, useState } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { extractTrustableDomain } from '../../../shared/browserDomainTrust'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { normalizeViewerUrl } from '../../../shared/viewerUrl'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import { summarizeBrowserConfirmInput } from './browserConfirmDisplay'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  onConfirm: ToolConfirmHandler
}

export function BrowserConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const { openUrl } = useDetailPanel()
  const [trustChecked, setTrustChecked] = useState(false)
  const summary = summarizeBrowserConfirmInput(record.input)
  if (!summary) return null

  const urlValue = summary.detailLabel === 'URL' ? summary.detailValue : ''
  const canOpenInViewer = Boolean(urlValue && urlValue !== '(未指定 URL)' && normalizeViewerUrl(urlValue))
  const action = typeof record.input.action === 'string' ? record.input.action : ''
  const mode = typeof record.input.mode === 'string' ? record.input.mode : 'open'
  const trustDomain = useMemo(
    () => (urlValue && urlValue !== '(未指定 URL)' ? extractTrustableDomain(urlValue) : null),
    [urlValue]
  )
  const canTrustDomain = action === 'navigate' && mode === 'open' && Boolean(trustDomain)

  const handleOpenInViewer = () => {
    if (!canOpenInViewer) return
    void openUrl(urlValue)
  }

  const handleConfirm: ToolConfirmHandler = (approved, options) => {
    if (approved && trustChecked && canTrustDomain && trustDomain) {
      onConfirm(approved, { ...options, trustDomain })
      return
    }
    onConfirm(approved, options)
  }

  return (
    <div className="write-confirm-card browser-confirm-card">
      <ConfirmCardDecision
        actionSummary={summary.headline}
        allowLabel={t('confirm.browser.allow')}
        denyLabel={t('confirm.browser.deny')}
        onConfirm={handleConfirm}
      >
        <div className="write-confirm-card__subject">
          {canOpenInViewer ? (
            <button
              type="button"
              className="write-confirm-card__subject-value browser-confirm-card__url browser-confirm-card__url-link"
              title={`在内容查看器中打开：${urlValue}`}
              onClick={handleOpenInViewer}
            >
              {urlValue}
            </button>
          ) : (
            <p className="write-confirm-card__subject-value browser-confirm-card__url" title={summary.detailValue}>
              {summary.detailValue}
            </p>
          )}
          {summary.hint ? (
            <p className="write-confirm-card__subject-note browser-confirm-card__hint">{summary.hint}</p>
          ) : null}
          {canTrustDomain ? (
            <label className="write-confirm-card__trust-option">
              <input
                type="checkbox"
                checked={trustChecked}
                onChange={(e) => setTrustChecked(e.target.checked)}
              />
              <span>{t('toolCall.confirm.trustThisDomain')}</span>
            </label>
          ) : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
