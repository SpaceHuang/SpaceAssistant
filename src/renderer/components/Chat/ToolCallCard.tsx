import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Space } from 'antd'
import { ChevronRight } from 'lucide-react'
import type { ShellConfig, ShellTerminalScrollback, ToolCallRecord } from '../../../shared/domainTypes'
import {
  hasShellOutput,
  hasTerminalScrollback,
  isShellSilentResult,
  parseShellResultData
} from '../../../shared/shellToolDisplay'
import { resolveEffectiveShellOutputMode } from '../../../shared/shellOutputMode'
import { patchShellTerminalScrollback } from '../../services/shellScrollbackPatch'
import {
  formatToolLabel,
  formatToolLabelTitle,
  isFileTool,
  isFileWriteTool,
  shouldAutoExpandShellToolRow,
  shouldCollapseBrowserDetectRow,
  shellToolCompletedLabel
} from './toolCallDisplay'
import { formatBrowserToolLabel, formatBrowserToolLabelTitle } from './browserConfirmDisplay'
import { ToolRowIcon } from './ToolRowIcon'
import { WriteConfirmCard } from './WriteConfirmCard'
import { BrowserConfirmCard } from './BrowserConfirmCard'
import { ShellConfirmCard } from './ShellConfirmCard'
import { BrowserDependencyGuideCard } from './BrowserDependencyGuideCard'
import { WriteSuccessCard } from './WriteSuccessCard'
import { ShellOutputView } from './ShellOutputView'
import { ShellTerminalView } from './ShellTerminalView'
import { ShellScrollbackView } from './ShellScrollbackView'
import { ShellTuiFallbackHint } from './ShellTuiFallbackHint'

type Props = {
  record: ToolCallRecord
  confirmMode: 'diff' | 'direct'
  focus?: boolean
  workDir?: string
  messageId?: string
  sessionId?: string
  shellConfig?: ShellConfig
  sessionMetadata?: Record<string, unknown>
  toolCalls?: ToolCallRecord[]
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

function shouldExpandReadOnlyShellOnComplete(record: ToolCallRecord): boolean {
  return (
    shouldAutoExpandShellToolRow(record) &&
    record.status === 'completed' &&
    !isShellSilentResult(record.result?.data)
  )
}

function defaultExpanded(record: ToolCallRecord): boolean {
  if (isFileWriteTool(record.toolName) && record.status === 'confirming') return true
  if (isBrowserListRowCollapsed(record)) return false
  if (shouldExpandReadOnlyShellOnComplete(record)) return true
  if (shouldCollapseBrowserDetectRow(record)) return false
  if (record.status === 'failed' || record.status === 'rejected') return true
  if (isFileTool(record.toolName)) return false
  if (record.status === 'confirming') return true
  return record.status === 'calling' || record.status === 'executing'
}

export function ToolCallCard({
  record,
  confirmMode,
  focus,
  workDir,
  messageId,
  sessionId,
  shellConfig,
  sessionMetadata,
  toolCalls,
  onConfirm,
  onCancel,
  onOpenFile
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [executingHint, setExecutingHint] = useState(false)
  const [terminalFallbackPlain, setTerminalFallbackPlain] = useState(false)
  const scrollbackPatchedRef = useRef(false)
  const shellOutputMode = resolveEffectiveShellOutputMode(shellConfig, sessionMetadata)
  const useTerminalUi = record.toolName === 'run_shell' && shellOutputMode === 'terminal' && !terminalFallbackPlain
  const isActive = record.status === 'calling' || record.status === 'executing' || record.status === 'confirming'
  const isFailed = record.status === 'failed' || record.status === 'rejected'
  const fileTool = isFileTool(record.toolName)
  const fileWriteTool = isFileWriteTool(record.toolName)
  const browserConfirming = record.toolName === 'browser' && record.status === 'confirming'
  const shellConfirming = record.toolName === 'run_shell' && record.status === 'confirming'
  const writeConfirming = fileWriteTool && record.status === 'confirming'
  const shellResultData = useMemo(
    () => (record.toolName === 'run_shell' ? parseShellResultData(record.result?.data) : undefined),
    [record.toolName, record.result?.data]
  )
  const shellHasFormattedOutput = record.toolName === 'run_shell' && hasShellOutput(shellResultData)
  const silentShellComplete =
    record.toolName === 'run_shell' &&
    record.status === 'completed' &&
    isShellSilentResult(record.result?.data)
  const hasDetail =
    !silentShellComplete &&
    (isActive ||
      isFailed ||
      Boolean(record.result?.success && record.result.data !== undefined) ||
      Boolean(record.confirmDiff) ||
      Boolean(record.toolName === 'run_shell' && (record.progressOutput || record.progressOutputRaw)) ||
      (!fileTool && record.status === 'completed' && Object.keys(record.input).length > 0))

  const [expanded, setExpanded] = useState(() => defaultExpanded(record))

  useEffect(() => {
    if (record.toolName !== 'run_shell' || record.status !== 'executing') {
      setExecutingHint(false)
      return
    }
    const t = window.setTimeout(() => setExecutingHint(true), 2000)
    return () => window.clearTimeout(t)
  }, [record.toolName, record.status])

  const handleTerminalBeforeDispose = useCallback(
    (scrollback: ShellTerminalScrollback | null) => {
      if (scrollbackPatchedRef.current || !scrollback || !messageId || !sessionId) return
      if (record.status === 'executing') return
      scrollbackPatchedRef.current = true
      patchShellTerminalScrollback({
        sessionId,
        messageId,
        toolUseId: record.id,
        toolCalls,
        scrollback
      })
    },
    [messageId, sessionId, record.id, record.status, toolCalls]
  )

  const shellCommand =
    record.toolName === 'run_shell' && typeof record.input.command === 'string' ? record.input.command : ''

  useEffect(() => {
    if (record.status === 'executing') scrollbackPatchedRef.current = false
  }, [record.status, record.id])

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
    if (shouldCollapseBrowserDetectRow(record)) {
      setExpanded(false)
      return
    }
    if (shouldExpandReadOnlyShellOnComplete(record)) {
      setExpanded(true)
      return
    }
    if (record.status === 'confirming' || isFailed) {
      setExpanded(true)
    }
  }, [fileTool, fileWriteTool, isFailed, record.status, record.toolName, record.input, record.result?.data])

  const showDetail = (expanded || writeConfirming || browserConfirming || shellConfirming) && hasDetail

  const label = useMemo(() => {
    const silent = shellToolCompletedLabel(record)
    if (silent) return silent
    if (record.toolName === 'browser') return formatBrowserToolLabel(record.input)
    return formatToolLabel(record.toolName, record.input)
  }, [record])
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
    if (record.toolName === 'run_shell' && (shellHasFormattedOutput || isShellSilentResult(record.result.data))) {
      return ''
    }
    if (record.result.success) {
      if (record.result.data === undefined) return ''
      return typeof record.result.data === 'string' ? record.result.data : JSON.stringify(record.result.data, null, 2)
    }
    return record.result.error ?? ''
  }, [record.result, record.toolName, shellHasFormattedOutput])

  const toggleExpanded = () => {
    if (!hasDetail || writeConfirming) return
    setExpanded((v) => !v)
  }

  const writeSucceeded = fileWriteTool && record.status === 'completed' && record.result?.success
  const showShellLivePlain =
    record.toolName === 'run_shell' &&
    record.status === 'executing' &&
    !useTerminalUi &&
    Boolean(record.progressOutput?.trim())
  const showShellLiveTerminal =
    record.toolName === 'run_shell' && record.status === 'executing' && useTerminalUi
  const keepLiveTerminalMounted = showShellLiveTerminal
  const showShellCompletedOutput =
    record.toolName === 'run_shell' &&
    (record.status === 'completed' || record.status === 'failed') &&
    (shellHasFormattedOutput || hasTerminalScrollback(shellResultData))
  const showShellCompletedTerminal =
    showShellCompletedOutput && useTerminalUi && hasTerminalScrollback(shellResultData)
  const showShellCompletedPlain =
    showShellCompletedOutput && (!useTerminalUi || !hasTerminalScrollback(shellResultData))
  const showGenericFailureMessage =
    (record.status === 'failed' || record.status === 'rejected') && !(record.toolName === 'run_shell' && showShellCompletedOutput)

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

  if (shellConfirming && onConfirm) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <ShellConfirmCard record={record} workDir={workDir} onConfirm={onConfirm} />
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

      {(showDetail || keepLiveTerminalMounted) ? (
        <div
          className="tool-row-detail"
          hidden={!showDetail && keepLiveTerminalMounted}
          aria-hidden={!showDetail && keepLiveTerminalMounted}
        >
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

          {showShellLiveTerminal ? (
            <ShellTerminalView
              progressOutputRaw={record.progressOutputRaw}
              visible={showDetail}
              onBeforeDispose={handleTerminalBeforeDispose}
              onInitFailed={() => setTerminalFallbackPlain(true)}
            />
          ) : null}

          {showShellLivePlain ? <ShellOutputView content={record.progressOutput} isLive /> : null}

          {record.status === 'executing' &&
          record.toolName === 'run_shell' &&
          !showShellLiveTerminal &&
          !showShellLivePlain &&
          executingHint ? (
            <span className="tool-row-detail__message">仍在运行…</span>
          ) : null}

          {shellCommand ? <ShellTuiFallbackHint command={shellCommand} workDir={workDir} /> : null}

          {record.status === 'executing' &&
          onCancel &&
          record.toolName !== 'browser' &&
          record.toolName !== 'run_shell' ? (
            <Button danger size="small" type="text" className="tool-row-detail__action" onClick={onCancel}>
              取消执行
            </Button>
          ) : null}

          {showGenericFailureMessage ? (
            <span className="tool-row-detail__message">
              {record.result?.error ?? (record.status === 'rejected' ? '已拒绝' : '失败')}
            </span>
          ) : null}

          {showShellCompletedTerminal && shellResultData ? (
            <ShellScrollbackView
              scrollback={shellResultData.terminalScrollback}
              stdout={shellResultData.stdout}
              stderr={shellResultData.stderr}
              exitCode={shellResultData.exitCode}
              truncated={shellResultData.truncated}
              persistedOutputPath={shellResultData.persistedOutputPath}
              expanded={expanded}
            />
          ) : null}

          {showShellCompletedPlain && shellResultData ? (
            <ShellOutputView
              stdout={shellResultData.stdout}
              stderr={shellResultData.stderr}
              exitCode={shellResultData.exitCode}
              truncated={shellResultData.truncated}
              persistedOutputPath={shellResultData.persistedOutputPath}
            />
          ) : null}

          {record.status === 'completed' && resultStr ? (
            <pre className="tool-code-preview tool-code-preview--inline">{truncate(resultStr, 4000)}</pre>
          ) : null}

          {record.status === 'completed' && !resultStr && !fileTool && !showShellCompletedOutput && Object.keys(record.input).length > 0 ? (
            <pre className="tool-code-preview tool-code-preview--inline">{paramPreview}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
