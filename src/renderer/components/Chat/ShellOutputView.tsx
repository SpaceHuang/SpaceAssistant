import { useEffect, useRef } from 'react'
import { normalizeTerminalOutput } from '../../../shared/terminalOutputSanitize'

type Props = {
  /** 实时模式：合并的 stdout+stderr 尾部 */
  content?: string
  isLive?: boolean
  /** 完成模式 */
  stdout?: string
  stderr?: string
  exitCode?: number | null
  truncated?: boolean
  persistedOutputPath?: string
}

export function ShellOutputView({
  content,
  isLive,
  stdout,
  stderr,
  exitCode,
  truncated,
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
      <pre ref={preRef} className="shell-output shell-output--live">
        {text}
      </pre>
    )
  }

  const out = normalizeTerminalOutput(stdout ?? '')
  const err = normalizeTerminalOutput(stderr ?? '')
  if (!out.trim() && !err.trim()) return null

  const showExitCode = typeof exitCode === 'number' && exitCode !== 0
  const hasFailure = showExitCode || Boolean(err.trim())

  return (
    <div className={`shell-output-block${hasFailure ? ' shell-output-block--failed' : ''}`}>
      {showExitCode ? <div className="shell-output__meta">退出码: {exitCode}</div> : null}
      {out.trim() ? <pre className="shell-output">{out}</pre> : null}
      {err.trim() ? <pre className="shell-output shell-output__stderr">{err}</pre> : null}
      {truncated && persistedOutputPath ? (
        <button
          type="button"
          className="shell-output__truncated-hint"
          onClick={() => void window.api.shellOpenOutputPath(persistedOutputPath)}
        >
          输出已截断，打开完整日志 →
        </button>
      ) : null}
    </div>
  )
}
