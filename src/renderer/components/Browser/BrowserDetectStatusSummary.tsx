import { useEffect, useRef, useState } from 'react'
import { Button, Typography } from 'antd'
import type { BrowserDetectResult } from '../../../shared/browserTypes'
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

function detectSummaryText(detect: BrowserDetectResult, ready: boolean): string {
  if (ready) return '网络访问功能正常'
  return detect.errors[0] ?? '浏览器依赖未就绪'
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
  return (
    <div className="browser-setup-guide__status">
      <div>
        Stagehand:{' '}
        <BrowserDetectDetailValue ok={detect.stagehand.installed}>
          {detect.stagehand.installed ? `已安装 ${detect.stagehand.version ?? ''}` : '未安装'}
        </BrowserDetectDetailValue>
      </div>
      <div>
        Playwright:{' '}
        <BrowserDetectDetailValue ok={detect.playwright.installed}>
          {detect.playwright.installed ? '已安装' : '未安装'}
        </BrowserDetectDetailValue>
      </div>
      <div>
        Chromium:{' '}
        <BrowserDetectDetailValue ok={detect.chromium.ready}>
          {detect.chromium.ready ? '已就绪' : '未安装'}
        </BrowserDetectDetailValue>
      </div>
      <div>
        Node: {detect.node.version}{' '}
        <BrowserDetectDetailValue ok={detect.node.meetsRequirement}>
          {detect.node.meetsRequirement ? '（应用内置）✓' : '✗'}
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
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const lastFingerprintRef = useRef<string | null>(null)
  const wasDetectingRef = useRef(false)
  const ready = isBrowserEnvironmentReady(detect)
  const summaryText = detectSummaryText(detect, ready)
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
          title="点击展开详情"
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
            收起
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
