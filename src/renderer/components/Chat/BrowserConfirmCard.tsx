import { useMemo, useState } from 'react'
import type { BrowserActDangerInfo, ToolCallRecord } from '../../../shared/domainTypes'
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

const STRONG_CONSEQUENCES = new Set(['money', 'data-loss', 'unknown-site'])

function maskFillValue(value: string, selector: string): string {
  if (/密码|口令|password/i.test(selector)) return '••••••'
  if (/\d{8,}/.test(value)) return `****${value.slice(-4)}`
  return value
}

function consequenceKey(consequence: BrowserActDangerInfo['consequence']): string {
  switch (consequence) {
    case 'money':
      return 'confirm.browserDangerConsequenceMoney'
    case 'data-loss':
      return 'confirm.browserDangerConsequenceDataLoss'
    case 'account':
      return 'confirm.browserDangerConsequenceAccount'
    case 'file':
      return 'confirm.browserDangerConsequenceFile'
    case 'unknown-site':
      return 'confirm.browserDangerConsequenceUnknownSite'
    default:
      return 'confirm.browserDangerConsequenceGeneric'
  }
}

export function BrowserConfirmCard({ record, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const { openUrl } = useDetailPanel()
  const [trustChecked, setTrustChecked] = useState(false)
  const summary = summarizeBrowserConfirmInput(record.input, record.currentPageUrl)

  const urlValue = summary?.detailLabel === 'URL' ? summary.detailValue : ''
  const pageUrl =
    typeof record.currentPageUrl === 'string' && record.currentPageUrl
      ? record.currentPageUrl
      : summary?.pageUrl ?? ''
  const action = typeof record.input.action === 'string' ? record.input.action : ''
  const mode = typeof record.input.mode === 'string' ? record.input.mode : 'open'
  const trustableDomain = useMemo(() => {
    if (action === 'navigate' && mode === 'open') {
      return urlValue && urlValue !== '(未指定 URL)' ? extractTrustableDomain(urlValue) : null
    }
    if (action === 'act') {
      return pageUrl ? extractTrustableDomain(pageUrl) : null
    }
    return null
  }, [action, mode, urlValue, pageUrl])

  if (!summary) return null

  const canOpenInViewer = Boolean(urlValue && urlValue !== '(未指定 URL)' && normalizeViewerUrl(urlValue))
  const canOpenPageInViewer = Boolean(pageUrl && normalizeViewerUrl(pageUrl))

  const dangerInfo = record.dangerInfo
  const isDangerous = action === 'act' && Boolean(dangerInfo)
  const isStrongDanger = isDangerous && dangerInfo && STRONG_CONSEQUENCES.has(dangerInfo.consequence)
  const sessionTrustedHint = record.sessionTrustedHint === true
  const canTrust = !isDangerous && ((action === 'navigate' && mode === 'open') || action === 'act')
  const canTrustDomain = canTrust && Boolean(trustableDomain)

  const handleOpenInViewer = () => {
    if (!canOpenInViewer) return
    void openUrl(urlValue)
  }

  const handleOpenPageInViewer = () => {
    if (!canOpenPageInViewer) return
    void openUrl(pageUrl)
  }

  const handleConfirm: ToolConfirmHandler = (approved, options) => {
    if (approved && trustChecked && canTrustDomain && trustableDomain) {
      if (action === 'act') {
        onConfirm(approved, { ...options, trustActDomain: trustableDomain })
      } else {
        onConfirm(approved, { ...options, trustDomain: trustableDomain })
      }
      return
    }
    onConfirm(approved, options)
  }

  const allowLabel =
    isDangerous ? t('confirm.shell.allowWithRisk') : t('confirm.browser.allow')

  const fillPreviewText =
    dangerInfo?.fillPreview?.length ?
      dangerInfo.fillPreview
        .map((f) => maskFillValue(f.value, f.selector))
        .join('、')
    : ''

  return (
    <div className={`write-confirm-card browser-confirm-card${isStrongDanger ? ' browser-confirm-card--danger-strong' : isDangerous ? ' browser-confirm-card--danger-mild' : ''}`}>
      {isDangerous && dangerInfo ? (
        <div className={`browser-confirm-card__danger${isStrongDanger ? ' browser-confirm-card__danger--strong' : ' browser-confirm-card__danger--mild'}`}>
          <p className="browser-confirm-card__danger-title">{t('confirm.browserDangerTitle')}</p>
          <p className="browser-confirm-card__danger-reason">{dangerInfo.userReason}</p>
          <p className="browser-confirm-card__danger-consequence">
            {t(consequenceKey(dangerInfo.consequence) as 'confirm.browserDangerConsequenceGeneric')}
          </p>
        </div>
      ) : null}
      <ConfirmCardDecision
        actionSummary={summary.headline}
        allowLabel={allowLabel}
        denyLabel={t('confirm.browser.deny')}
        onConfirm={handleConfirm}
      >
        <div className="write-confirm-card__subject browser-confirm-card__subject">
          {action === 'act' ? (
            <>
              {summary.instructionValue ? (
                <div className="browser-confirm-card__field">
                  <span className="browser-confirm-card__field-label">{t('confirm.browserInstruction')}</span>
                  <p
                    className="write-confirm-card__subject-value browser-confirm-card__instruction"
                    title={summary.instructionValue}
                  >
                    {summary.instructionValue}
                  </p>
                </div>
              ) : null}
              {pageUrl ? (
                <div className="browser-confirm-card__field">
                  <span className="browser-confirm-card__field-label">{t('confirm.browserCurrentPage')}</span>
                  {canOpenPageInViewer ? (
                    <button
                      type="button"
                      className="browser-confirm-card__url browser-confirm-card__url-link"
                      title={`${t('confirm.browserCurrentPage')}：${pageUrl}`}
                      onClick={handleOpenPageInViewer}
                    >
                      {pageUrl}
                    </button>
                  ) : (
                    <p className="browser-confirm-card__url" title={pageUrl}>
                      {pageUrl}
                    </p>
                  )}
                </div>
              ) : null}
            </>
          ) : canOpenInViewer ? (
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
          {fillPreviewText ? (
            <p className="write-confirm-card__subject-note browser-confirm-card__fill-preview">
              {t('confirm.browserDangerFillPreview', { values: fillPreviewText })}
            </p>
          ) : null}
          {summary.hint && !canTrustDomain ? (
            <p className="write-confirm-card__subject-note browser-confirm-card__hint">{summary.hint}</p>
          ) : null}
          {sessionTrustedHint ? (
            <p className="write-confirm-card__subject-note browser-confirm-card__session-trusted-hint">
              {t('confirm.browserSessionTrustedHint')}
            </p>
          ) : null}
          {canTrustDomain ? (
            <div className="browser-confirm-card__trust-block">
              <label className="write-confirm-card__trust-option">
                <span className="write-confirm-card__trust-control">
                  <input
                    type="checkbox"
                    checked={trustChecked}
                    aria-describedby={action === 'act' ? `browser-trust-safety-${record.id}` : undefined}
                    onChange={(e) => setTrustChecked(e.target.checked)}
                  />
                </span>
                <span className="write-confirm-card__trust-label">
                  {action === 'act' ? t('confirm.browserActTrust') : t('toolCall.confirm.trustThisDomain')}
                </span>
              </label>
              {action === 'act' ? (
                <p className="browser-confirm-card__trust-safety" id={`browser-trust-safety-${record.id}`}>
                  {t('confirm.browserActTrustSafety')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
