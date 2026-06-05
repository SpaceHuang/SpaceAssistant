import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Typography } from 'antd'
import type { BrowserDetectResult } from '../../../shared/browserTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  detect: BrowserDetectResult
  className?: string
  /** 检测完成后默认折叠为单行摘要（就绪/未就绪均适用） */
  defaultCollapsed?: boolean
  /** 为 true 时表示正在拉取检测结果；结束后会自动收起详情 */
  detecting?: boolean
  children?: React.ReactNode
}

function ExpandChevronIcon() {
  return (
    <svg
      className="browser-setup-guide__expand-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
    </svg>
  )
}

export function isBrowserEnvironmentReady(detect: BrowserDetectResult): boolean {
  return (
    detect.canInitialize &&
    detect.stagehand.installed &&
    detect.playwright.installed &&
    detect.chromium.ready &&
    detect.node.meetsRequirement
  )
}

function detectFingerprint(detect: BrowserDetectResult): string {
  return [
    detect.primaryFailure,
    detect.canInitialize,
    detect.chromium.ready,
    detect.stagehand.installed,
    detect.playwright.installed,
    detect.node.meetsRequirement,
    detect.errors[0] ?? ''
  ].join('|')
}

export function BrowserDetectStatusRows({ detect }: { detect: BrowserDetectResult }) {
  const { t: tConfig } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')

  return (
    <div className="browser-setup-guide__status" style={{ fontSize: 13 }}>
      <div>
        Stagehand:{' '}
        {detect.stagehand.installed ? (
          <Typography.Text type="success">{tCommon('status.installed')} {detect.stagehand.version ?? ''}</Typography.Text>
        ) : (
          <Typography.Text type="danger">{tCommon('status.notInstalled')}</Typography.Text>
        )}
      </div>
      <div>
        Playwright:{' '}
        {detect.playwright.installed ? (
          <Typography.Text type="success">{tCommon('status.installed')}</Typography.Text>
        ) : (
          <Typography.Text type="danger">{tCommon('status.notInstalled')}</Typography.Text>
        )}
      </div>
      <div>
        Chromium:{' '}
        {detect.chromium.ready ? (
          <Typography.Text type="success">{tCommon('status.ready')}</Typography.Text>
        ) : (
          <Typography.Text type="danger">{tCommon('status.notInstalled')}</Typography.Text>
        )}
      </div>
      <div>
        Node: {detect.node.version}{' '}
        {detect.node.meetsRequirement ? (
          <Typography.Text type="success">{tCommon('status.builtinNode')} ✓</Typography.Text>
        ) : (
          <Typography.Text type="danger">✗</Typography.Text>
        )}
      </div>
    </div>
  )
}

export function BrowserDetectStatusSummary({
  detect,
  className,
  defaultCollapsed = true,
  detecting = false,
  children
}: Props) {
  const { t } = useTypedTranslation('config')
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const lastFingerprintRef = useRef<string | null>(null)
  const wasDetectingRef = useRef(false)
  const ready = isBrowserEnvironmentReady(detect)

  const summaryText = ready
    ? t('browser.detectNetworkOk')
    : (detect.errors[0] || t('browser.depsNotReadyTitle'))

  const fingerprint = detectFingerprint(detect)

  useEffect(() => {
    if (wasDetectingRef.current && !detecting) {
      setDetailsExpanded(false)
    }
    wasDetectingRef.current = detecting
  }, [detecting])

  useEffect(() => {
    if (lastFingerprintRef.current !== null && lastFingerprintRef.current !== fingerprint) {
      setDetailsExpanded(false)
    }
    lastFingerprintRef.current = fingerprint
  }, [fingerprint])

  if (defaultCollapsed && !detailsExpanded) {
    const expand = () => setDetailsExpanded(true)
    return (
      <>
        <div
          className={`browser-setup-guide--compact-wrap ${className ?? ''}`.trim()}
          title={t('browser.detectExpandHint')}
          role="button"
          tabIndex={0}
          onClick={expand}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              expand()
            }
          }}
        >
          <Alert
            className="browser-setup-guide browser-setup-guide--compact"
            type={ready ? 'success' : 'warning'}
            showIcon
            message={
              <span className="browser-setup-guide__compact-row">
                <span>{summaryText}</span>
                <ExpandChevronIcon />
              </span>
            }
          />
        </div>
        {children}
      </>
    )
  }

  return (
    <div className={`browser-setup-guide ${className ?? ''}`.trim()}>
      <div className="browser-setup-guide__header">
        <Typography.Text strong>{summaryText}</Typography.Text>
        {defaultCollapsed ? (
          <Button
            type="link"
            size="small"
            className="browser-setup-guide__collapse"
            onClick={() => setDetailsExpanded(false)}
          >
            {t('browser.detectCollapse')}
          </Button>
        ) : null}
      </div>
      <div style={{ marginBottom: children ? 12 : 0 }}>
        <BrowserDetectStatusRows detect={detect} />
      </div>
      {children}
    </div>
  )
}
