import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ShellTerminalScrollback } from '../../../shared/domainTypes'
import { pickScrollbackRestorePayload } from '../../../shared/terminalScrollback'
import { buildShellTerminalOptions } from './terminalTheme'
import { ShellOutputView } from './ShellOutputView'
import {
  deferDisposeTerminal,
  restoreTerminalScrollbackPayload,
  safeFitTerminalRows,
  scheduleTerminalMount,
  whenDocumentFontsReady
} from './xtermHelpers'
import { SHELL_TERMINAL_COLS } from './terminalTheme'

type Props = {
  scrollback?: ShellTerminalScrollback
  stdout?: string
  stderr?: string
  exitCode?: number | null
  truncated?: boolean
  persistedOutputPath?: string
  expanded: boolean
}

export function ShellScrollbackView({
  scrollback,
  stdout,
  stderr,
  exitCode,
  truncated,
  persistedOutputPath,
  expanded
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)

  const restore = pickScrollbackRestorePayload(scrollback)
  const showExitCode = typeof exitCode === 'number' && exitCode !== 0

  useEffect(() => {
    if (!expanded || restore.kind === 'none' || restore.kind === 'plain') return
    const host = hostRef.current
    if (!host || restoredRef.current) return

    let cancelled = false
    let term: Terminal | null = null
    let ro: ResizeObserver | null = null

    const mountTerminal = () => {
      if (cancelled || !hostRef.current || restoredRef.current) return

      try {
        term = new Terminal(
          buildShellTerminalOptions({
            cols: scrollback?.cols ?? SHELL_TERMINAL_COLS,
            rows: scrollback?.rows ?? 24
          })
        )
        const fit = new FitAddon()
        const fixedCols = scrollback?.cols ?? SHELL_TERMINAL_COLS
        term.loadAddon(fit)
        term.open(hostRef.current)
        safeFitTerminalRows(term, fit, hostRef.current, fixedCols)
        requestAnimationFrame(() => {
          if (cancelled || !term) return
          safeFitTerminalRows(term, fit, hostRef.current, fixedCols)
          restoreTerminalScrollbackPayload(
            term,
            restore.payload,
            restore.kind === 'serialized' ? 'serialized' : 'ansi'
          )
        })
        void whenDocumentFontsReady().then(() => {
          if (cancelled || !term) return
          safeFitTerminalRows(term, fit, hostRef.current, fixedCols)
        })
        ro = new ResizeObserver(() => {
          if (cancelled || !term) return
          safeFitTerminalRows(term, fit, hostRef.current, fixedCols)
        })
        ro.observe(hostRef.current)
        restoredRef.current = true
      } catch {
        restoredRef.current = false
      }
    }

    const cancelMount = scheduleTerminalMount(mountTerminal)

    return () => {
      cancelled = true
      cancelMount()
      ro?.disconnect()
      restoredRef.current = false
      deferDisposeTerminal(term)
      term = null
    }
  }, [expanded, restore.kind, restore.payload, scrollback?.cols, scrollback?.rows])

  if (restore.kind === 'plain' || restore.kind === 'none') {
    return (
      <ShellOutputView
        stdout={stdout ?? scrollback?.plainText}
        stderr={stderr}
        exitCode={exitCode}
        truncated={truncated}
        persistedOutputPath={persistedOutputPath}
      />
    )
  }

  if (!expanded) {
    return showExitCode ? <div className="shell-output__meta">退出码: {exitCode}</div> : null
  }

  return (
    <div className="shell-output-block">
      {showExitCode ? <div className="shell-output__meta">退出码: {exitCode}</div> : null}
      {scrollback?.truncated ? (
        <div className="shell-output__meta">终端记录已截断（超过 256KB）</div>
      ) : null}
      <div className="shell-terminal-wrap shell-terminal-wrap--static">
        <div ref={hostRef} className="shell-terminal-host" />
      </div>
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
