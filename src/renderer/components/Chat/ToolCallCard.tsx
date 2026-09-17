import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'antd'
import { ChevronRight } from 'lucide-react'
import type { FileConfirmMode, ShellConfig, ShellTerminalScrollback, ToolCallRecord } from '../../../shared/domainTypes'
import { projectPersistedMcpResult, type McpResultDisplay } from '../../../shared/mcpToolResultDisplay'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import {
  hasShellOutput,
  hasTerminalScrollback,
  isShellSilentResult,
  parseShellResultData
} from '../../../shared/shellToolDisplay'
import { resolveEffectiveShellOutputMode } from '../../../shared/shellOutputMode'
import { isInteractiveShellTuiCommand } from '../../../shared/shellInteractiveTui'
import { patchShellTerminalScrollback } from '../../services/shellScrollbackPatch'
import { toolCallDetailsLoader } from '../../services/toolCallDetailsLoader'
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
import { McpConfirmCard } from './McpConfirmCard'
import { ToolkitConfirmCard } from './ToolkitConfirmCard'
import { ShellConfirmCard } from './ShellConfirmCard'
import { ScriptConfirmCard } from './ScriptConfirmCard'
import { ScriptCodePreview, ScriptTimeoutMeta } from './ScriptCodePreview'
import { LarkCliConfirmCard } from './LarkCliConfirmCard'
import { BrowserDependencyGuideCard } from './BrowserDependencyGuideCard'
import { WriteSuccessCard } from './WriteSuccessCard'
import { ShellOutputView } from './ShellOutputView'
import { ShellTerminalView } from './ShellTerminalView'
import { ShellScrollbackView } from './ShellScrollbackView'
import { ShellTuiFallbackHint } from './ShellTuiFallbackHint'
import { McpToolResultView } from './McpToolResultView'

function isMcpRecord(record: ToolCallRecord): boolean {
  return Boolean(record.mcp) || record.toolName.startsWith('mcp_')
}

function getMcpDisplay(record: ToolCallRecord): McpResultDisplay | undefined {
  if (record.result?.displayData) return record.result.displayData
  if (!isMcpRecord(record) || !record.result?.success) return undefined
  return projectPersistedMcpResult(record.result.data)
}
import { McpElapsed } from './McpElapsed'
import { scrollIntoViewWithMotionPreference } from '../../utils/motionPreference'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { buildFragmentId } from '../../../shared/chatSearchFragments'
import { formatToolDuration } from '../../../shared/toolDurationFormat'
import { getToolDurationPhases } from '../../../shared/toolDurationPhases'
import type { ChatSearchActiveTarget } from '../../services/chatSearchActiveTarget'
import type { ToolCallDisplaySummary } from '../../../shared/turnDisplayProtocol'

type Props = {
  record: ToolCallRecord
  confirmMode: FileConfirmMode
  focus?: boolean
  workDir?: string
  messageId?: string
  turnId?: string
  displaySummary?: ToolCallDisplaySummary
  confirmationReady?: boolean
  sessionId?: string
  shellConfig?: ShellConfig
  sessionMetadata?: Record<string, unknown>
  toolCalls?: ToolCallRecord[]
  onConfirm?: ToolConfirmHandler
  onCancel?: () => void
  onOpenFile?: (relPath: string) => void
  activeSearchTarget?: ChatSearchActiveTarget | null
}

export function getMcpStatusTranslationKey(status: ToolCallRecord['status'], interrupted = false):
  | 'mcp.statusRunning'
  | 'mcp.statusSuccess'
  | 'mcp.statusRejected'
  | 'mcp.statusInterrupted'
  | 'mcp.statusAwaitingConfirm'
  | 'mcp.statusFailed' {
  if (status === 'calling' || status === 'executing') return 'mcp.statusRunning'
  if (status === 'confirming') return 'mcp.statusAwaitingConfirm'
  if (status === 'completed') return 'mcp.statusSuccess'
  if (status === 'rejected') return 'mcp.statusRejected'
  return interrupted ? 'mcp.statusInterrupted' : 'mcp.statusFailed'
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…'
}

/** 浏览器列表行默认收起；确认态与执行中由 BrowserConfirmCard / 详情区展示 */
function isBrowserListRowCollapsed(record: ToolCallRecord): boolean {
  return record.toolName === 'browser' && record.status !== 'confirming' && record.status !== 'executing'
}

function shouldAutoExpandExecuting(record: ToolCallRecord): boolean {
  if (record.status !== 'executing') return false
  if (record.toolName === 'run_shell' || record.toolName === 'run_script') return true
  if (record.progressOutput?.trim() || record.progressOutputRaw?.trim()) return true
  return record.toolName === 'browser'
}

function defaultExpanded(record: ToolCallRecord): boolean {
  if (isFileWriteTool(record.toolName) && record.status === 'confirming') return true
  if (isBrowserListRowCollapsed(record)) return false
  if (shouldCollapseBrowserDetectRow(record)) return false
  if (record.status === 'failed' || record.status === 'rejected') return true
  if (isFileTool(record.toolName)) return false
  if (record.status === 'confirming') return true
  if (shouldAutoExpandExecuting(record)) return true
  if (record.status === 'completed') return false
  return false
}

export const ToolCallCard = memo(function ToolCallCard({
  record: sourceRecord,
  confirmMode,
  focus,
  workDir,
  messageId,
  turnId,
  displaySummary,
  confirmationReady,
  sessionId,
  shellConfig,
  sessionMetadata,
  toolCalls,
  onConfirm,
  onCancel,
  onOpenFile,
  activeSearchTarget = null
}: Props) {
  const { t } = useTypedTranslation('chat')
  const [loadedDetail, setLoadedDetail] = useState<ToolCallRecord | undefined>()
  // 详情是补充数据；只有它对应当前 source 快照时才允许参与展示。
  const [loadedForSource, setLoadedForSource] = useState<ToolCallRecord | undefined>()
  const record = loadedDetail && loadedForSource === sourceRecord
    ? { ...loadedDetail, ...sourceRecord, input: Object.keys(sourceRecord.input).length ? sourceRecord.input : loadedDetail.input, result: sourceRecord.result ?? loadedDetail.result }
    : sourceRecord
  const mcp = isMcpRecord(record)
  const currentLoadedDetail = loadedDetail && loadedForSource === sourceRecord ? loadedDetail : undefined
  const cardRef = useRef<HTMLDivElement>(null)
  const [executingHint, setExecutingHint] = useState(false)
  const [terminalFallbackPlain, setTerminalFallbackPlain] = useState(false)
  const scrollbackPatchedRef = useRef(false)
  const shellOutputMode = resolveEffectiveShellOutputMode(shellConfig, sessionMetadata)
  const shellCommand =
    record.toolName === 'run_shell' && typeof record.input.command === 'string' ? record.input.command : ''
  const scriptCode =
    record.toolName === 'run_script' && typeof record.input.code === 'string' ? record.input.code : ''
  const scriptTimeout =
    record.toolName === 'run_script' && typeof record.input.timeout === 'number' ? record.input.timeout : undefined
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
  const scriptResultData = useMemo(
    () => (record.toolName === 'run_script' ? parseShellResultData(record.result?.data) : undefined),
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
    (Boolean(displaySummary?.hasDetails) || Boolean(displaySummary?.resultPreviewTruncated) ||
      isFailed ||
      pendingHasDetail ||
      Boolean(record.result?.success && record.result.data !== undefined) ||
      Boolean(record.confirmDiff) ||
      Boolean(record.toolName === 'run_shell' && (record.progressOutput || record.progressOutputRaw)) ||
      Boolean(record.toolName === 'run_script' && scriptCode.trim()) ||
      (!fileTool && record.status === 'completed' && Object.keys(record.input).length > 0))

  const [expanded, setExpanded] = useState(() => defaultExpanded(record))
  const userExpandedBeforeSearchRef = useRef<boolean | null>(null)
  const searchReveal =
    Boolean(activeSearchTarget?.revealPath?.toolUseId) &&
    activeSearchTarget?.revealPath?.toolUseId === record.id
  const searchSection = searchReveal ? activeSearchTarget?.revealPath?.toolSection : undefined

  useEffect(() => {
    if (!expanded || !sessionId || !turnId || !messageId || sourceRecord.result || sourceRecord.status === 'confirming') return
    let alive = true
    const sourceAtRequest = sourceRecord
    const revision = `${sourceRecord.status}:${sourceRecord.completedAt ?? ''}:${sourceRecord.result ? 'result' : 'preview'}`
    void toolCallDetailsLoader.load({ sessionId, turnId, messageId, toolCallId: sourceRecord.id, revision }).then((detail) => {
      if (alive && detail) {
        setLoadedDetail(detail)
        setLoadedForSource(sourceAtRequest)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [expanded, messageId, sourceRecord, sourceRecord.result, sourceRecord.status, sessionId, turnId])

  useEffect(() => {
    if (searchReveal) {
      if (userExpandedBeforeSearchRef.current == null) {
        userExpandedBeforeSearchRef.current = expanded
      }
      setExpanded(true)
      return
    }
    if (userExpandedBeforeSearchRef.current != null) {
      setExpanded(userExpandedBeforeSearchRef.current)
      userExpandedBeforeSearchRef.current = null
    }
  }, [searchReveal]) // eslint-disable-line react-hooks/exhaustive-deps -- 仅搜索覆盖进出时恢复

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
    // 搜索定位是一次明确的用户意图，不能被下面按工具状态的自动收起规则覆盖。
    if (focus) return
    if (fileWriteTool) {
      if (record.status === 'confirming') {
        setExpanded((prev) => (prev ? prev : true))
        return
      }
      if (record.status === 'completed' || record.status === 'executing') {
        setExpanded((prev) => (prev ? false : prev))
        return
      }
      if (isFailed) {
        setExpanded((prev) => (prev ? prev : true))
      }
      return
    }
    if (fileTool && record.status === 'completed') {
      setExpanded((prev) => (prev ? false : prev))
      return
    }
    if (isBrowserListRowCollapsed(record)) {
      setExpanded((prev) => (prev ? false : prev))
      return
    }
    if (shouldCollapseBrowserDetectRow(record)) {
      setExpanded((prev) => (prev ? false : prev))
      return
    }
    if (record.status === 'confirming' || isFailed) {
      setExpanded((prev) => (prev ? prev : true))
      return
    }
    if (shouldAutoExpandExecuting(record)) {
      setExpanded((prev) => (prev ? prev : true))
    }
  }, [focus, fileTool, fileWriteTool, isFailed, record.status, record.toolName, record.progressOutput, record.progressOutputRaw])

  const showDetail =
    (expanded ||
      searchReveal ||
      writeConfirming ||
      browserConfirming ||
      shellConfirming ||
      scriptConfirming ||
      larkCliConfirming) &&
    hasDetail

  const mcpDisplay = useMemo(
    () => record.result?.displayData ?? ((showDetail || activeSearchTarget) ? getMcpDisplay(record) : undefined),
    [record.result, showDetail, activeSearchTarget]
  )

  const label = useMemo(() => {
    const silent = shellToolCompletedLabel(record, t)
    if (silent) return silent
    if (record.toolName === 'browser') return formatBrowserToolLabel(record.input)
    return formatToolLabel(record.toolName, record.input, t, record.mcp)
  }, [record, t])
  const labelTitle = useMemo(() => {
    if (record.toolName === 'browser') return formatBrowserToolLabelTitle(record.input)
    return formatToolLabelTitle(record.toolName, record.input, t, record.mcp)
  }, [record.toolName, record.input, record.mcp, t])
  const durationPhases = mcp && showDetail
    ? getToolDurationPhases({ startedAt: record.startedAt, confirmedAt: record.confirmedAt, completedAt: record.completedAt })
    : {}

  const paramPreview = useMemo(() => {
    if (!showDetail) return ''
    try {
      return JSON.stringify(record.input, null, 2)
    } catch {
      return String(record.input)
    }
  }, [showDetail, record.input])

  const resultStr = useMemo(() => {
    const result = currentLoadedDetail?.result ?? record.result
    if (!showDetail || !result) return ''
    if (mcp && mcpDisplay) return ''
    if (record.toolName === 'run_shell' && (shellHasFormattedOutput || isShellSilentResult(result.data))) {
      return ''
    }
    if (record.toolName === 'run_script') return ''
    if (result.success) {
      if (result.data === undefined) return ''
      return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
    }
    return formatUserFacingError(result.error ?? '')
  }, [showDetail, currentLoadedDetail?.result, record.result, record.toolName, shellHasFormattedOutput])

  const labelFragmentId =
    messageId != null ? buildFragmentId(messageId, { kind: 'tool-label', toolUseId: record.id }) : undefined
  const inputFragmentId =
    messageId != null ? buildFragmentId(messageId, { kind: 'tool-input', toolUseId: record.id }) : undefined
  const resultFragmentId =
    messageId != null ? buildFragmentId(messageId, { kind: 'tool-result', toolUseId: record.id }) : undefined

  const showSearchInput =
    searchReveal && (searchSection === 'input' || searchSection == null) && Boolean(paramPreview)
  const showSearchResult =
    searchReveal && (searchSection === 'result' || searchSection == null) && Boolean(resultStr)
  const searchInputOwnsFragment = activeSearchTarget?.fragmentId === inputFragmentId
  const searchResultOwnsFragment = activeSearchTarget?.fragmentId === resultFragmentId
  const renderFullSearchInput = searchInputOwnsFragment && (activeSearchTarget?.end ?? 0) > 4000
  const renderFullSearchResult = searchResultOwnsFragment && (activeSearchTarget?.end ?? 0) > 4000
  const displayedResultText = searchResultOwnsFragment ? activeSearchTarget?.searchableText ?? resultStr : resultStr

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
    showShellCompletedOutput && useTerminalUi && hasTerminalScrollback(shellResultData) && !searchResultOwnsFragment
  const showShellCompletedPlain =
    showShellCompletedOutput && (!useTerminalUi || !hasTerminalScrollback(shellResultData) || searchResultOwnsFragment)
  const showScriptCode = record.toolName === 'run_script' && Boolean(scriptCode.trim())
  const showScriptLiveOutput =
    record.toolName === 'run_script' && record.status === 'executing' && Boolean(record.progressOutput?.trim())
  const showScriptCompletedOutput =
    record.toolName === 'run_script' &&
    (record.status === 'completed' || record.status === 'failed') &&
    hasShellOutput(scriptResultData)
  const showGenericFailureMessage =
    (record.status === 'failed' || record.status === 'rejected') &&
    !(record.toolName === 'run_shell' && showShellCompletedOutput) &&
    !(record.toolName === 'run_script' && showScriptCompletedOutput)
  const earlySearchFragmentId =
    activeSearchTarget && [labelFragmentId, inputFragmentId, resultFragmentId].includes(activeSearchTarget.fragmentId)
      ? activeSearchTarget.fragmentId
      : undefined
  const earlySearchText = earlySearchFragmentId ? activeSearchTarget?.searchableText : undefined

  const mcpConfirming = Boolean(mcp && record.status === 'confirming')
  // toolkit 网关确认卡：事件名为 compat 名（toolkit_call），双口径匹配
  const toolkitConfirming =
    (record.toolName === 'toolkit.call' || record.toolName === 'toolkit_call') && record.status === 'confirming'

  if (mcpConfirming && onConfirm && confirmationReady !== false) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <McpConfirmCard record={record} onConfirm={onConfirm} sessionId={sessionId} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (toolkitConfirming && onConfirm && confirmationReady !== false) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <ToolkitConfirmCard record={record} onConfirm={onConfirm} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (writeConfirming && onConfirm && confirmationReady !== false) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <WriteConfirmCard record={record} confirmMode={confirmMode} onConfirm={onConfirm} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (browserConfirming && onConfirm && confirmationReady !== false) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <BrowserConfirmCard record={record} onConfirm={onConfirm} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (shellConfirming && onConfirm && confirmationReady !== false) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <ShellConfirmCard record={record} workDir={workDir} onConfirm={onConfirm} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (scriptConfirming && onConfirm && confirmationReady !== false) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <ScriptConfirmCard record={record} onConfirm={onConfirm} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (larkCliConfirming && onConfirm && confirmationReady !== false) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <LarkCliConfirmCard record={record} onConfirm={onConfirm} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (record.toolName === 'browser' && record.result?.dependencyRecovery) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <BrowserDependencyGuideCard
          dependencyRecovery={record.result.dependencyRecovery}
          actionLabel={label}
        />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
      </div>
    )
  }

  if (writeSucceeded) {
    return (
      <div ref={cardRef} className={focus ? 'tool-row--focus' : undefined}>
        <WriteSuccessCard record={record} onView={onOpenFile} />
        {earlySearchText ? <pre className="sa-chat-inset-code sa-search-reveal-source" data-search-fragment-id={earlySearchFragmentId}>{earlySearchText}</pre> : null}
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
        <span
          className="tool-row__label"
          title={labelTitle ?? label}
          data-search-fragment-id={labelFragmentId}
        >
          {label}
        </span>
        {mcp ? (
          <span className={`tool-row__status tool-row__status--${record.status}`} data-testid="mcp-status">
            {t(getMcpStatusTranslationKey(record.status, record.interrupted))}
          </span>
        ) : null}
        {mcp && record.duration !== undefined && record.status !== 'rejected' ? (
          <span className="tool-row__duration" data-testid="tool-duration">{formatToolDuration(record.duration)}</span>
        ) : null}
        {mcp && (record.status === 'calling' || record.status === 'executing') && record.startedAt !== undefined ? (
          <McpElapsed startedAt={record.startedAt} />
        ) : null}
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
          {mcp && showDetail && durationPhases.totalMs !== undefined ? (
            <div className="tool-row-detail__message tool-row__duration-phases">
              {durationPhases.waitingMs !== undefined ? `${t('mcp.waitingConfirm', { value: formatToolDuration(durationPhases.waitingMs) })} · ` : ''}
              {t('mcp.execution', { value: formatToolDuration(durationPhases.executionMs ?? 0) })} · {t('mcp.total', { value: formatToolDuration(durationPhases.totalMs) })}
            </div>
          ) : null}
          {showShellLiveTerminal ? (
            <ShellTerminalView
              progressOutputRaw={record.progressOutputRaw}
              outputEncodingLabel={record.progressOutputRawLabel}
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
              {record.result?.userMessage ?? record.result?.error ?? (record.status === 'rejected' ? t('tool.rejected') : t('tool.failed'))}
            </span>
          ) : null}
          {mcp && record.status === 'failed' ? (
            <Button size="small" type="link" className="tool-row-detail__action" onClick={() => window.dispatchEvent(new CustomEvent('sa-open-settings', { detail: { tab: 'tools', toolsSubTab: 'mcp' } }))}>
              {t('mcp.openSettings')}
            </Button>
          ) : null}

          {showShellCompletedTerminal && shellResultData ? (
            <div data-search-fragment-id={resultFragmentId}>
              <ShellScrollbackView
                scrollback={shellResultData.terminalScrollback}
                stdout={shellResultData.stdout ?? shellResultData.terminalScrollback?.plainText ?? shellResultData.terminalScrollback?.ansiText}
                stderr={shellResultData.stderr}
                exitCode={shellResultData.exitCode}
                truncated={shellResultData.truncated}
                artifactId={shellResultData.artifactId}
                persistedOutputPath={shellResultData.persistedOutputPath}
                outputTrust={shellResultData.outputTrust}
                expanded={expanded}
              />
            </div>
          ) : null}

          {showShellCompletedPlain && shellResultData ? (
            <div data-search-fragment-id={resultFragmentId}>
              <ShellOutputView
                stdout={shellResultData.stdout ?? shellResultData.terminalScrollback?.plainText ?? shellResultData.terminalScrollback?.ansiText}
                stderr={shellResultData.stderr}
                exitCode={shellResultData.exitCode}
                truncated={shellResultData.truncated}
                artifactId={shellResultData.artifactId}
                persistedOutputPath={shellResultData.persistedOutputPath}
                outputTrust={shellResultData.outputTrust}
              />
            </div>
          ) : null}

          {showScriptCode ? (
            <div className="tool-code-preview tool-row-detail__script-code">
              <ScriptCodePreview code={scriptCode} />
              {scriptTimeout !== undefined ? <ScriptTimeoutMeta timeout={scriptTimeout} /> : null}
            </div>
          ) : null}

          {showScriptLiveOutput ? <ShellOutputView content={record.progressOutput} isLive /> : null}

          {showScriptCompletedOutput && scriptResultData ? (
            <div data-search-fragment-id={resultFragmentId}>
              <ShellOutputView
                stdout={scriptResultData.stdout}
                stderr={scriptResultData.stderr}
                exitCode={scriptResultData.exitCode}
              />
            </div>
          ) : null}

          {record.status === 'completed' && resultStr ? (
            <pre
              className="sa-chat-inset-code sa-command-inset"
              data-search-fragment-id={resultFragmentId}
            >
              {renderFullSearchResult ? displayedResultText : truncate(displayedResultText, 4000)}
            </pre>
          ) : null}

          {mcp && showDetail && record.status === 'completed' && mcpDisplay ? (
            <McpToolResultView display={mcpDisplay} fragmentId={resultFragmentId} messageId={messageId} toolUseId={record.id} activeSearchTarget={searchResultOwnsFragment ? activeSearchTarget : null} />
          ) : null}

          {showSearchResult && !(record.status === 'completed' && resultStr) ? (
            <pre
              className="sa-chat-inset-code sa-command-inset"
              data-search-fragment-id={resultFragmentId}
            >
              {renderFullSearchResult ? displayedResultText : truncate(displayedResultText, 4000)}
            </pre>
          ) : null}

          {(record.status === 'completed' &&
            !resultStr &&
            !fileTool &&
            !showShellCompletedOutput &&
            record.toolName !== 'run_script' &&
            Object.keys(record.input).length > 0) ||
          showSearchInput ? (
            <pre
              className="sa-chat-inset-code sa-command-inset"
              data-search-fragment-id={inputFragmentId}
            >
              {renderFullSearchInput ? paramPreview : truncate(paramPreview, 4000)}
            </pre>
          ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
})
