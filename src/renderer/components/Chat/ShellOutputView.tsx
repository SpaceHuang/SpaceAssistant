import { useEffect, useRef } from 'react'
import { formatShellStderrDisplay, normalizeTerminalOutput } from '../../../shared/terminalOutputSanitize'
import { REDACTED_ARTIFACT_ID } from '../../../shared/processResultProjection'

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
}

export function ShellOutputView({
  content,
  isLive,
  stdout,
  stderr,
  exitCode,
  truncated,
  artifactId,
  persistedOutputPath
}: Props) {
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (isLive && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [content, isLive])

  if (isLive) {
    const text = normalizeTerminalOutput(content ?? '')
    if (!text.trim()) return null
    return (
      <pre ref={preRef} className="shell-output shell-output--live sa-command-inset">
        {text}
      </pre>
    )
  }

  const out = normalizeTerminalOutput(stdout ?? '')
  const errDisplay = formatShellStderrDisplay(stderr ?? '', exitCode)
  if (!out.trim() && !errDisplay.trim()) return null

  const hasFailure = Boolean(errDisplay.trim())
  // 兜底 artifact id 一定打不开（主进程返回 INVALID_PATH），不要给出点了没反应的入口。
  const openTarget = artifactId && artifactId !== REDACTED_ARTIFACT_ID ? artifactId : persistedOutputPath

  return (
    <div className={`shell-output-block${hasFailure ? ' shell-output-block--failed' : ''}`}>
      {out.trim() ? <pre className="shell-output">{out}</pre> : null}
      {out.trim() && errDisplay.trim() ? '\n' : null}
      {errDisplay.trim() ? <pre className="shell-output shell-output__stderr">{errDisplay}</pre> : null}
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
