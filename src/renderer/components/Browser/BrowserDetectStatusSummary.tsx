import { useEffect, useRef, useState } from 'react'
import { Button, Typography } from 'antd'
import type { BrowserDetectResult } from '../../../shared/browserTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import {
  BrowserDetectDetailValue,
  BrowserRuntimeCheckCompactRow,
  ExpandChevronIcon
} from './BrowserRuntimeCheckUi'

type Props = {
  detect: BrowserDetectResult
  className?: string
  /** 检测完成后默认折叠为单行摘要（就绪/未就绪均适用） */
  defaultCollapsed?: boolean
  /** 为 true 时表示正在拉取检测结果；结束后会自动收起详情 */
  detecting?: boolean
  children?: React.ReactNode
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
  const { t: tCommon } = useTypedTranslation('common')

  return (
    <div className="browser-setup-guide__status">
      <div>
        Stagehand:{' '}
        <BrowserDetectDetailValue ok={detect.stagehand.installed}>
          {detect.stagehand.installed
            ? `${tCommon('status.installed')} ${detect.stagehand.version ?? ''}`
            : tCommon('status.notInstalled')}
        </BrowserDetectDetailValue>
      </div>
      <div>
        Playwright:{' '}
        <BrowserDetectDetailValue ok={detect.playwright.installed}>
          {detect.playwright.installed ? tCommon('status.installed') : tCommon('status.notInstalled')}
        </BrowserDetectDetailValue>
      </div>
      <div>
        Chromium:{' '}
        <BrowserDetectDetailValue ok={detect.chromium.ready}>
          {detect.chromium.ready ? tCommon('status.ready') : tCommon('status.notInstalled')}
        </BrowserDetectDetailValue>
      </div>
      <div>
        Node: {detect.node.version}{' '}
        <BrowserDetectDetailValue ok={detect.node.meetsRequirement}>
          {detect.node.meetsRequirement ? `${tCommon('status.builtinNode')} ✓` : '✗'}
        </BrowserDetectDetailValue>
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
          <BrowserRuntimeCheckCompactRow tone={ready ? 'success' : 'warning'}>
            <span>{summaryText}</span>
            <ExpandChevronIcon />
          </BrowserRuntimeCheckCompactRow>
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
