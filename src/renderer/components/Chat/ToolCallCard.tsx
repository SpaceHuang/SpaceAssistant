import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'antd'
import { ChevronRight } from 'lucide-react'
import type { ShellConfig, ShellTerminalScrollback, ToolCallRecord } from '../../../shared/domainTypes'
import {
  hasShellOutput,
  hasTerminalScrollback,
  isShellSilentResult,
  parseShellResultData
} from '../../../shared/shellToolDisplay'
import { resolveEffectiveShellOutputMode } from '../../../shared/shellOutputMode'
import { isInteractiveShellTuiCommand } from '../../../shared/shellInteractiveTui'
import { patchShellTerminalScrollback } from '../../services/shellScrollbackPatch'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import {
  formatToolLabel,
  formatToolLabelTitle,
  isFileTool,
  isFileWriteTool,
  shouldCollapseBrowserDetectRow,
  shellToolCompletedLabel
} from './toolCallDisplay'
import { formatBrowserToolLabel, formatBrowserToolLabelTitle } from './browserConfirmDisplay'
import { ToolRowIcon } from './ToolRowIcon'
import { WriteConfirmCard } from './WriteConfirmCard'
import { BrowserConfirmCard } from './BrowserConfirmCard'
import { ShellConfirmCard } from './ShellConfirmCard'
import { ScriptConfirmCard } from './ScriptConfirmCard'
import { LarkCliConfirmCard } from './LarkCliConfirmCard'
import { BrowserDependencyGuideCard } from './BrowserDependencyGuideCard'
import { WriteSuccessCard } from './WriteSuccessCard'
import { ShellOutputView } from './ShellOutputView'
import { ShellTerminalView } from './ShellTerminalView'
import { ShellScrollbackView } from './ShellScrollbackView'
import { ShellTuiFallbackHint } from './ShellTuiFallbackHint'
import { scrollIntoViewWithMotionPreference } from '../../utils/motionPreference'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

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

function defaultExpanded(record: ToolCallRecord): boolean {
  if (isFileWriteTool(record.toolName) && record.status === 'confirming') return true
  if (isBrowserListRowCollapsed(record)) return false
  if (shouldCollapseBrowserDetectRow(record)) return false
  if (record.status === 'failed' || record.status === 'rejected') return true
  if (isFileTool(record.toolName)) return false
  if (record.status === 'confirming') return true
  if (record.status === 'completed') return false
  return false
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
  const { t } = useTypedTranslation('chat')
  const cardRef = useRef<HTMLDivElement>(null)
  const [executingHint, setExecutingHint] = useState(false)
  const [terminalFallbackPlain, setTerminalFallbackPlain] = useState(false)
  const scrollbackPatchedRef = useRef(false)
  const shellOutputMode = resolveEffectiveShellOutputMode(shellConfig, sessionMetadata)
  const shellCommand =
    record.toolName === 'run_shell' && typeof record.input.command === 'string' ? record.input.command : ''
  const isInteractiveTui = shellCommand ? isInteractiveShellTuiCommand(shellCommand) : false
  const hasPlainProgress = Boolean(record.progressOutput?.trim())
  const hasRawProgress = Boolean(record.progressOutputRaw?.trim())
  const useTerminalUi =
    record.toolName === 'run_shell' &&
    shellOutputMode === 'terminal' &&
    !terminalFallbackPlain &&
    !isInteractiveTui
  const isPending = record.status === 'calling' || record.status === 'executing'
  const isFailed = record.status === 'failed' || record.status === 'rejected'
  const fileTool = isFileTool(record.toolName)
  const fileWriteTool = isFileWriteTool(record.toolName)
  const browserConfirming = record.toolName === 'browser' && record.status === 'confirming'
  const shellConfirming = record.toolName === 'run_shell' && record.status === 'confirming'
  const scriptConfirming = record.toolName === 'run_script' && record.status === 'confirming'
  const larkCliConfirming = record.toolName === 'run_lark_cli' && record.status === 'confirming'
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
  const pendingHasDetail =
    isPending &&
    (record.toolName === 'run_shell' ||
      (record.toolName !== 'browser' &&
        record.toolName !== 'browser_detect' &&
        record.toolName !== 'grep'))
  const hasDetail =
    !silentShellComplete &&
    (isFailed ||
      pendingHasDetail ||
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

  useEffect(() => {
    if (record.status === 'executing') scrollbackPatchedRef.current = false
  }, [record.status, record.id])

  useEffect(() => {
    if (focus && cardRef.current) {
      scrollIntoViewWithMotionPreference(cardRef.current, { block: 'nearest', behavior: 'smooth' })
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
    if (record.status === 'confirming' || isFailed) {
      setExpanded(true)
    }
  }, [fileTool, fileWriteTool, isFailed, record.status, record.toolName, record.input, record.result?.data])

  const showDetail = (expanded || writeConfirming || browserConfirming || shellConfirming || scriptConfirming || larkCliConfirming) && hasDetail

  const label = useMemo(() => {
    const silent = shellToolCompletedLabel(record, t)
    if (silent) return silent
    if (record.toolName === 'browser') return formatBrowserToolLabel(record.input)
    return formatToolLabel(record.toolName, record.input, t)
  }, [record, t])
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
    return formatUserFacingError(record.result.error ?? '')
  }, [record.result, record.toolName, shellHasFormattedOutput])

  const toggleExpanded = () => {
    if (!hasDetail || writeConfirming) return
    setExpanded((v) => !v)
  }

  const writeSucceeded = fileWriteTool && record.status === 'completed' && record.result?.success
  const showShellLiveTerminal =
    record.toolName === 'run_shell' &&
    record.status === 'executing' &&
    useTerminalUi &&
    (hasRawProgress || !hasPlainProgress)
  const showShellLivePlain =
    record.toolName === 'run_shell' &&
    record.status === 'executing' &&
    hasPlainProgress &&
    !showShellLiveTerminal
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

  if (scriptConfirming && onConfirm) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <ScriptConfirmCard record={record} onConfirm={onConfirm} />
      </div>
    )
  }

  if (larkCliConfirming && onConfirm) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <LarkCliConfirmCard record={record} onConfirm={onConfirm} />
      </div>
    )
  }

  if (record.toolName === 'browser' && record.result?.dependencyRecovery) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <div className="tool-row tool-row--failed tool-row--expanded">
          <div className="tool-row__main">
            <ToolRowIcon toolName={record.toolName} />
            <span className="tool-row__label" title={labelTitle ?? label}>
              {label}
            </span>
          </div>
          <div className="tool-row-detail tool-row-detail--open">
            <div className="tool-row-detail__inner">
              <BrowserDependencyGuideCard dependencyRecovery={record.result.dependencyRecovery} />
            </div>
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
        isPending ? 'tool-row--pending' : '',
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
        aria-expanded={hasDetail ? showDetail : undefined}
        onKeyDown={(e) => {
          if (!hasDetail) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleExpanded()
          }
        }}
      >
        <ToolRowIcon toolName={record.toolName} pending={isPending} />
        <span className="tool-row__label" title={labelTitle ?? label}>
          {label}
        </span>
        {hasDetail ? (
          <ChevronRight size={12} strokeWidth={2} className="tool-row__chevron" aria-hidden />
        ) : null}
      </div>

      {(hasDetail || keepLiveTerminalMounted) ? (
        <div
          className={[
            'tool-row-detail',
            showDetail ? 'tool-row-detail--open' : 'tool-row-detail--collapsed'
          ].join(' ')}
          aria-hidden={!showDetail}
        >
          <div className="tool-row-detail__inner">
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
          !isInteractiveTui &&
          executingHint ? (
            <span className="tool-row-detail__message">{t('tool.pending')}</span>
          ) : null}

          {shellCommand ? <ShellTuiFallbackHint command={shellCommand} workDir={workDir} /> : null}

          {record.status === 'executing' &&
          onCancel &&
          record.toolName !== 'browser' &&
          record.toolName !== 'browser_detect' &&
          record.toolName !== 'grep' &&
          record.toolName !== 'run_shell' ? (
            <Button danger size="small" type="text" className="tool-row-detail__action" onClick={onCancel}>
              {t('tool.cancel')}
            </Button>
          ) : null}

          {showGenericFailureMessage ? (
            <span className="tool-row-detail__message">
              {record.result?.error ?? (record.status === 'rejected' ? t('tool.rejected') : t('tool.failed'))}
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
            <pre className="sa-chat-inset-code sa-command-inset">{truncate(resultStr, 4000)}</pre>
          ) : null}

          {record.status === 'completed' && !resultStr && !fileTool && !showShellCompletedOutput && Object.keys(record.input).length > 0 ? (
            <pre className="sa-chat-inset-code sa-command-inset">{paramPreview}</pre>
          ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
