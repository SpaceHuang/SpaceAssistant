import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import { exportTerminalScrollback, type TerminalExportSource } from '../../../shared/terminalScrollback'
import type { ShellTerminalScrollback } from '../../../shared/domainTypes'
import { buildShellTerminalOptions, SHELL_TERMINAL_COLS } from './terminalTheme'
import {
  deferDisposeTerminal,
  replayTerminalRaw,
  safeFitTerminalRows,
  scheduleTerminalMount,
  whenDocumentFontsReady
} from './xtermHelpers'

type Props = {
  progressOutputRaw?: string
  onExportReady?: (exporter: () => ShellTerminalScrollback | null) => void
  /** 卸载前导出 scrollback（在 dispose 之前调用） */
  onBeforeDispose?: (scrollback: ShellTerminalScrollback | null) => void
  onInitFailed?: () => void
}

export function ShellTerminalView({
  progressOutputRaw,
  onExportReady,
  onBeforeDispose,
  onInitFailed
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const serializeRef = useRef<SerializeAddon | null>(null)
  const latestRawRef = useRef('')
  const followRef = useRef(true)
  const disposedRef = useRef(false)
  const readyRef = useRef(false)
  const [showResumeFollow, setShowResumeFollow] = useState(false)
  const rafRef = useRef<number | null>(null)
  const onBeforeDisposeRef = useRef(onBeforeDispose)
  const onExportReadyRef = useRef(onExportReady)
  const onInitFailedRef = useRef(onInitFailed)

  useEffect(() => {
    onBeforeDisposeRef.current = onBeforeDispose
    onExportReadyRef.current = onExportReady
    onInitFailedRef.current = onInitFailed
  })

  const replayOutput = useCallback(() => {
    if (disposedRef.current || !readyRef.current) return
    const term = termRef.current
    if (!term) return
    replayTerminalRaw(term, latestRawRef.current, { followBottom: followRef.current })
  }, [])

  const scheduleReplay = useCallback(() => {
    if (disposedRef.current || rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      replayOutput()
    })
  }, [replayOutput])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let cancelled = false
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let serialize: SerializeAddon | null = null
    let ro: ResizeObserver | null = null
    let readyRaf: number | null = null
    let scrollDispose: { dispose: () => void } | undefined

    disposedRef.current = false
    readyRef.current = false

    const buildExporter = (): (() => ShellTerminalScrollback | null) => {
      return () => {
        const t = termRef.current
        const ser = serializeRef.current
        if (!t) return null
        const source: TerminalExportSource = {
          cols: t.cols,
          rows: t.rows,
          serialize: ser ? () => ser.serialize() : undefined,
          getAnsiText: () => {
            const lines: string[] = []
            const buf = t.buffer.active
            for (let i = 0; i < buf.length; i++) {
              lines.push(buf.getLine(i)?.translateToString(true) ?? '')
            }
            return lines.join('\n')
          },
          getPlainText: () => {
            const lines: string[] = []
            const buf = t.buffer.active
            for (let i = 0; i < buf.length; i++) {
              lines.push(buf.getLine(i)?.translateToString(false) ?? '')
            }
            return lines.join('\n')
          }
        }
        return exportTerminalScrollback(source)
      }
    }

    const refitAndReplay = () => {
      if (cancelled || disposedRef.current || !term || !fit) return
      safeFitTerminalRows(term, fit, hostRef.current, SHELL_TERMINAL_COLS)
      if (readyRef.current) replayOutput()
    }

    const mountTerminal = () => {
      if (cancelled || !hostRef.current) return

      try {
        term = new Terminal(buildShellTerminalOptions())
        fit = new FitAddon()
        serialize = new SerializeAddon()
        term.loadAddon(fit)
        term.loadAddon(serialize)
        term.open(hostRef.current)
        safeFitTerminalRows(term, fit, hostRef.current, SHELL_TERMINAL_COLS)

        termRef.current = term
        fitRef.current = fit
        serializeRef.current = serialize
        followRef.current = true

        scrollDispose = term.onScroll(() => {
          if (disposedRef.current) return
          try {
            const buffer = term!.buffer.active
            const atBottom = buffer.baseY + buffer.viewportY >= buffer.baseY + term!.rows - 1
            if (!atBottom) {
              followRef.current = false
              setShowResumeFollow(true)
            }
          } catch {
            /* disposed */
          }
        })

        ro = new ResizeObserver(() => refitAndReplay())
        ro.observe(hostRef.current)

        void whenDocumentFontsReady().then(() => refitAndReplay())

        onExportReadyRef.current?.(buildExporter())

        readyRaf = requestAnimationFrame(() => {
          readyRaf = null
          if (cancelled || disposedRef.current) return
          readyRef.current = true
          replayOutput()
        })
      } catch {
        onInitFailedRef.current?.()
      }
    }

    const cancelMount = scheduleTerminalMount(mountTerminal)

    return () => {
      cancelled = true
      disposedRef.current = true
      readyRef.current = false
      cancelMount()
      if (readyRaf !== null) {
        cancelAnimationFrame(readyRaf)
        readyRaf = null
      }
      ro?.disconnect()
      scrollDispose?.dispose()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }

      replayOutput()
      const exported = buildExporter()()
      onBeforeDisposeRef.current?.(exported)

      termRef.current = null
      fitRef.current = null
      serializeRef.current = null

      deferDisposeTerminal(term)
      term = null
    }
  }, [replayOutput])

  useEffect(() => {
    latestRawRef.current = progressOutputRaw ?? ''
    scheduleReplay()
  }, [progressOutputRaw, scheduleReplay])

  const resumeFollow = () => {
    followRef.current = true
    setShowResumeFollow(false)
    try {
      termRef.current?.scrollToBottom()
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="shell-terminal-wrap">
      <div ref={hostRef} className="shell-terminal-host" />
      {showResumeFollow ? (
        <button type="button" className="shell-terminal__resume-follow" onClick={resumeFollow}>
          恢复跟随
        </button>
      ) : null}
    </div>
  )
}
