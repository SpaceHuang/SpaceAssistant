import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Space } from 'antd'
import { ChevronRight } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { formatToolLabel, formatToolLabelTitle, isFileTool, isFileWriteTool } from './toolCallDisplay'
import { formatBrowserToolLabel, formatBrowserToolLabelTitle } from './browserConfirmDisplay'
import { ToolRowIcon } from './ToolRowIcon'
import { WriteConfirmCard } from './WriteConfirmCard'
import { BrowserConfirmCard } from './BrowserConfirmCard'
import { BrowserDependencyGuideCard } from './BrowserDependencyGuideCard'
import { WriteSuccessCard } from './WriteSuccessCard'

type Props = {
  record: ToolCallRecord
  confirmMode: 'diff' | 'direct'
  focus?: boolean
  onConfirm?: (approved: boolean) => void
  onCancel?: () => void
  onOpenFile?: (relPath: string) => void
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…'
}

/** 浏览器列表行默认收起；确认态由 BrowserConfirmCard 单独展示 */
function isBrowserListRowCollapsed(record: ToolCallRecord): boolean {
  return record.toolName === 'browser' && record.status !== 'confirming'
}

function defaultExpanded(record: ToolCallRecord): boolean {
  if (isFileWriteTool(record.toolName) && record.status === 'confirming') return true
  if (isBrowserListRowCollapsed(record)) return false
  if (record.status === 'failed' || record.status === 'rejected') return true
  if (isFileTool(record.toolName)) return false
  if (record.status === 'confirming') return true
  return record.status === 'calling' || record.status === 'executing'
}

export function ToolCallCard({ record, confirmMode, focus, onConfirm, onCancel, onOpenFile }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  const isActive = record.status === 'calling' || record.status === 'executing' || record.status === 'confirming'
  const isFailed = record.status === 'failed' || record.status === 'rejected'
  const fileTool = isFileTool(record.toolName)
  const fileWriteTool = isFileWriteTool(record.toolName)
  const browserConfirming = record.toolName === 'browser' && record.status === 'confirming'
  const writeConfirming = fileWriteTool && record.status === 'confirming'
  const hasDetail =
    isActive ||
    isFailed ||
    Boolean(record.result?.success && record.result.data !== undefined) ||
    Boolean(record.confirmDiff) ||
    (!fileTool && record.status === 'completed' && Object.keys(record.input).length > 0)

  const [expanded, setExpanded] = useState(() => defaultExpanded(record))

  useEffect(() => {
    if (focus && cardRef.current) {
      cardRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      setExpanded(true)
    }
  }, [focus])

  useEffect(() => {
    if (fileWriteTool) {
      if (record.status === 'confirming') {
        setExpanded(true)
        return
      }
      if (record.status === 'completed' || record.status === 'executing') {
        setExpanded(false)
        return
      }
      if (isFailed) {
        setExpanded(true)
      }
      return
    }
    if (fileTool && record.status === 'completed') {
      setExpanded(false)
      return
    }
    if (isBrowserListRowCollapsed(record)) {
      setExpanded(false)
      return
    }
    if (record.status === 'confirming' || isFailed) {
      setExpanded(true)
    }
  }, [fileTool, fileWriteTool, isFailed, record.status, record.toolName])

  const showDetail = (expanded || writeConfirming || browserConfirming) && hasDetail

  const label = useMemo(() => {
    if (record.toolName === 'browser') return formatBrowserToolLabel(record.input)
    return formatToolLabel(record.toolName, record.input)
  }, [record.toolName, record.input])
  const labelTitle = useMemo(() => {
    if (record.toolName === 'browser') return formatBrowserToolLabelTitle(record.input)
    return formatToolLabelTitle(record.toolName, record.input)
  }, [record.toolName, record.input])

  const paramPreview = useMemo(() => {
    try {
      return JSON.stringify(record.input, null, 2)
    } catch {
      return String(record.input)
    }
  }, [record.input])

  const resultStr = useMemo(() => {
    if (!record.result) return ''
    if (record.result.success) {
      if (record.result.data === undefined) return ''
      return typeof record.result.data === 'string' ? record.result.data : JSON.stringify(record.result.data, null, 2)
    }
    return record.result.error ?? ''
  }, [record.result])

  const toggleExpanded = () => {
    if (!hasDetail || writeConfirming) return
    setExpanded((v) => !v)
  }

  const writeSucceeded = fileWriteTool && record.status === 'completed' && record.result?.success

  if (writeConfirming && onConfirm) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <WriteConfirmCard record={record} confirmMode={confirmMode} onConfirm={onConfirm} />
      </div>
    )
  }

  if (browserConfirming && onConfirm) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <BrowserConfirmCard record={record} onConfirm={onConfirm} />
      </div>
    )
  }

  if (record.toolName === 'browser' && record.result?.dependencyRecovery) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <div className="tool-row tool-row--failed tool-row--expanded">
          <div className="tool-row__main">
            <ToolRowIcon toolName={record.toolName} active={false} />
            <span className="tool-row__label" title={labelTitle ?? label}>
              {label}
            </span>
          </div>
          <div className="tool-row-detail">
            <BrowserDependencyGuideCard dependencyRecovery={record.result.dependencyRecovery} />
          </div>
        </div>
      </div>
    )
  }

  if (writeSucceeded) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <WriteSuccessCard record={record} onView={onOpenFile} />
      </div>
    )
  }

  return (
    <div
      ref={cardRef}
      className={[
        'tool-row',
        isActive ? 'tool-row--active' : '',
        isFailed ? 'tool-row--failed' : '',
        hasDetail ? 'tool-row--clickable' : '',
        showDetail ? 'tool-row--expanded' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="tool-row__main"
        onClick={toggleExpanded}
        role={hasDetail ? 'button' : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        onKeyDown={(e) => {
          if (!hasDetail) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleExpanded()
          }
        }}
      >
        <ToolRowIcon toolName={record.toolName} active={record.status === 'calling' || record.status === 'executing'} />
        <span className="tool-row__label" title={labelTitle ?? label}>
          {label}
        </span>
        {hasDetail && !isActive ? (
          <ChevronRight size={12} strokeWidth={2} className="tool-row__chevron" aria-hidden />
        ) : null}
      </div>

      {showDetail ? (
        <div className="tool-row-detail">
          {record.status === 'confirming' && onConfirm ? (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {record.toolName === 'run_script' && typeof record.input.code === 'string' ? (
                <pre className="tool-code-preview tool-code-preview--inline">{record.input.code}</pre>
              ) : null}
              <Space size={8}>
                <Button type="primary" size="small" onClick={() => onConfirm(true)}>
                  确认
                </Button>
                <Button size="small" onClick={() => onConfirm(false)}>
                  拒绝
                </Button>
              </Space>
            </Space>
          ) : null}

          {record.status === 'executing' && onCancel && record.toolName !== 'browser' ? (
            <Button danger size="small" type="text" className="tool-row-detail__action" onClick={onCancel}>
              取消执行
            </Button>
          ) : null}

          {(record.status === 'failed' || record.status === 'rejected') && (
            <span className="tool-row-detail__message">
              {record.result?.error ?? (record.status === 'rejected' ? '已拒绝' : '失败')}
            </span>
          )}

          {record.status === 'completed' && resultStr ? (
            <pre className="tool-code-preview tool-code-preview--inline">{truncate(resultStr, 4000)}</pre>
          ) : null}

          {record.status === 'completed' && !resultStr && !fileTool && Object.keys(record.input).length > 0 ? (
            <pre className="tool-code-preview tool-code-preview--inline">{paramPreview}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
