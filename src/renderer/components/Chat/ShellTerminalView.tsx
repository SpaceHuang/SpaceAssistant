import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import { decodeProgressRawTailForXterm, exportTerminalScrollback, type TerminalExportSource } from '../../../shared/terminalScrollback'
import type { ShellTerminalScrollback } from '../../../shared/domainTypes'
import { buildShellTerminalOptions, SHELL_TERMINAL_COLS } from './terminalTheme'
import {
  appendTerminalRawProgress,
  attachShellTerminalCopy,
  deferDisposeTerminal,
  replayTerminalRaw,
  safeFitTerminalRows,
  scheduleTerminalMount,
  whenDocumentFontsReady,
  type TerminalRawWriteState
} from './xtermHelpers'

type Props = {
  progressOutputRaw?: string
  /** 卡片展开时为 true；收起时保持挂载但隐藏，展开后需 refit/重绘 */
  visible?: boolean
  onExportReady?: (exporter: () => ShellTerminalScrollback | null) => void
  /** 卸载前导出 scrollback（在 dispose 之前调用） */
  onBeforeDispose?: (scrollback: ShellTerminalScrollback | null) => void
  onInitFailed?: () => void
}

export function ShellTerminalView({
  progressOutputRaw,
  visible = true,
  onExportReady,
  onBeforeDispose,
  onInitFailed
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const serializeRef = useRef<SerializeAddon | null>(null)
  const latestRawRef = useRef('')
  const writeStateRef = useRef<TerminalRawWriteState>({ writtenTextLen: 0, cols: SHELL_TERMINAL_COLS })
  const followRef = useRef(true)
  const disposedRef = useRef(false)
  const readyRef = useRef(false)
  const [showResumeFollow, setShowResumeFollow] = useState(false)
  const onBeforeDisposeRef = useRef(onBeforeDispose)
  const onExportReadyRef = useRef(onExportReady)
  const onInitFailedRef = useRef(onInitFailed)

  useEffect(() => {
    onBeforeDisposeRef.current = onBeforeDispose
    onExportReadyRef.current = onExportReady
    onInitFailedRef.current = onInitFailed
  })

  const syncOutput = useCallback(() => {
    if (disposedRef.current || !readyRef.current) return
    const term = termRef.current
    if (!term) return
    writeStateRef.current = appendTerminalRawProgress(
      term,
      latestRawRef.current,
      writeStateRef.current,
      { followBottom: followRef.current }
    )
  }, [])

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
    let copyDispose: { dispose: () => void } | undefined

    disposedRef.current = false
    readyRef.current = false
    writeStateRef.current = { writtenTextLen: 0, cols: SHELL_TERMINAL_COLS }

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

    const refitAndSync = () => {
      if (cancelled || disposedRef.current || !term || !fit) return
      safeFitTerminalRows(term, fit, hostRef.current)
      if (readyRef.current) syncOutput()
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
        safeFitTerminalRows(term, fit, hostRef.current)

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

        copyDispose = attachShellTerminalCopy(term)

        ro = new ResizeObserver(() => refitAndSync())
        ro.observe(hostRef.current)

        void whenDocumentFontsReady().then(() => refitAndSync())

        onExportReadyRef.current?.(buildExporter())

        readyRaf = requestAnimationFrame(() => {
          readyRaf = null
          if (cancelled || disposedRef.current) return
          readyRef.current = true
          syncOutput()
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
      copyDispose?.dispose()

      syncOutput()
      const exported = buildExporter()()
      onBeforeDisposeRef.current?.(exported)

      termRef.current = null
      fitRef.current = null
      serializeRef.current = null

      deferDisposeTerminal(term)
      term = null
    }
  }, [syncOutput])

  useEffect(() => {
    latestRawRef.current = progressOutputRaw ?? ''
    syncOutput()
  }, [progressOutputRaw, syncOutput])

  useEffect(() => {
    if (!visible || !readyRef.current) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    requestAnimationFrame(() => {
      if (disposedRef.current || !readyRef.current) return
      safeFitTerminalRows(term, fit, hostRef.current)
      replayTerminalRaw(term, latestRawRef.current)
      writeStateRef.current = {
        writtenTextLen: latestRawRef.current ? decodeProgressRawTailForXterm(latestRawRef.current).length : 0,
        cols: term.cols
      }
    })
  }, [visible])

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
    <div
      className="shell-terminal-wrap sa-code-scrollbar"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div ref={hostRef} className="shell-terminal-host" />
      {showResumeFollow ? (
        <button type="button" className="shell-terminal__resume-follow" onClick={resumeFollow}>
          恢复跟随
        </button>
      ) : null}
    </div>
  )
}
