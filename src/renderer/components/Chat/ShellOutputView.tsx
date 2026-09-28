import { useEffect, useRef, useState } from 'react'
import { formatShellStderrDisplay, normalizeTerminalOutput } from '../../../shared/terminalOutputSanitize'
import { REDACTED_ARTIFACT_ID } from '../../../shared/processResultProjection'
import { needsOutputTrustNotice } from '../../../shared/shellToolDisplay'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  /** 实时模式：合并的 stdout+stderr 尾部 */
  content?: string
  isLive?: boolean
  /** 完成模式 */
  stdout?: string
  stderr?: string
  exitCode?: number | null
  truncated?: boolean
  artifactId?: string
  persistedOutputPath?: string
  /** §10.4：outputTrust=suspect 时显式提示「文本可能不可信」 */
  outputTrust?: 'ok' | 'suspect'
}

// live 输出提交节奏：主进程 tool-progress 每次输出都推 progressPreview 尾部快照（4KB 滑动窗口，
// 窗口前移使整块文本全变），不节流时 <pre> 每帧整块重绘 + scrollTop 强制贴底，视觉上
// 详情区「内容快速刷新」。尾随节流保证最后一次变化必被提交，内容稳定后停表零开销。
const LIVE_COMMIT_INTERVAL_MS = 120

export function ShellOutputView({
  content,
  isLive,
  stdout,
  stderr,
  exitCode,
  truncated,
  artifactId,
  persistedOutputPath,
  outputTrust
}: Props) {
  const { t } = useTypedTranslation('chat')
  const preRef = useRef<HTMLPreElement>(null)
  const [liveText, setLiveText] = useState(() => normalizeTerminalOutput(content ?? ''))
  const liveTextRef = useRef(liveText)
  const lastCommitAtRef = useRef<number>(Date.now())
  const commitTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isLive) return
    const next = normalizeTerminalOutput(content ?? '')
    if (next === liveTextRef.current) return
    liveTextRef.current = next
    const elapsed = Date.now() - lastCommitAtRef.current
    if (elapsed >= LIVE_COMMIT_INTERVAL_MS) {
      if (commitTimerRef.current !== null) {
        window.clearTimeout(commitTimerRef.current)
        commitTimerRef.current = null
      }
      lastCommitAtRef.current = Date.now()
      setLiveText(next)
      return
    }
    if (commitTimerRef.current !== null) return
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null
      lastCommitAtRef.current = Date.now()
      setLiveText(liveTextRef.current)
    }, LIVE_COMMIT_INTERVAL_MS - elapsed)
  }, [content, isLive])

  useEffect(() => () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
  }, [])

  useEffect(() => {
    if (isLive && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [liveText, isLive])

  if (isLive) {
    if (!liveText.trim()) return null
    return (
      <pre ref={preRef} className="shell-output shell-output--live sa-command-inset">
        {liveText}
      </pre>
    )
  }

  const out = normalizeTerminalOutput(stdout ?? '')
  const errDisplay = formatShellStderrDisplay(stderr ?? '', exitCode)
  const suspect = needsOutputTrustNotice({ outputTrust })
  // §10.4：可疑提示不能因为文本为空而被吞掉——“看不到字”正是最需要提示的情形。
  if (!out.trim() && !errDisplay.trim() && !suspect) return null

  const hasFailure = Boolean(errDisplay.trim())
  // 兜底 artifact id 一定打不开（主进程返回 INVALID_PATH），不要给出点了没反应的入口。
  const openTarget = artifactId && artifactId !== REDACTED_ARTIFACT_ID ? artifactId : persistedOutputPath

  return (
    <div className={`shell-output-block${hasFailure ? ' shell-output-block--failed' : ''}`}>
      {out.trim() ? <pre className="shell-output">{out}</pre> : null}
      {out.trim() && errDisplay.trim() ? '\n' : null}
      {errDisplay.trim() ? <pre className="shell-output shell-output__stderr">{errDisplay}</pre> : null}
      {suspect ? (
        <div className="shell-output__trust-warning" role="status">
          {t('shell.outputTrustSuspect')}
        </div>
      ) : null}
      {truncated && openTarget ? (
        <button
          type="button"
          className="shell-output__truncated-hint"
          onClick={() => void window.api.shellOpenOutputPath(openTarget)}
        >
          输出已截断，打开完整日志 →
        </button>
      ) : null}
    </div>
  )
}
