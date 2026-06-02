import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { decodeProgressRawTailForXterm, normalizeXtermPipeInput } from '../../../shared/terminalScrollback'
import {
  SHELL_TERMINAL_COLS,
  SHELL_TERMINAL_FONT_SIZE,
  SHELL_TERMINAL_MIN_COLS
} from './terminalTheme'

export function whenDocumentFontsReady(): Promise<unknown> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    return document.fonts.ready
  }
  return Promise.resolve()
}

/** 容器已挂载且有可见尺寸 */
export function isTerminalHostReady(host: HTMLElement | null | undefined): boolean {
  if (!host || !host.isConnected) return false
  return host.clientWidth >= 2 && host.clientHeight >= 2
}

export function forceTerminalCols(term: Terminal, fixedCols: number, fallbackRows = 24): void {
  try {
    if (term.cols !== fixedCols) {
      term.resize(fixedCols, Math.max(1, term.rows || fallbackRows))
    }
  } catch {
    /* disposed */
  }
}

export type SafeFitTerminalOptions = {
  maxCols?: number
  minCols?: number
  /** 历史 scrollback 列数：展示时不超过该值，且不超过容器可容纳列数 */
  savedCols?: number
  fontSize?: number
}

function estimateTerminalColsFromWidth(host: HTMLElement, fontSize: number): number {
  const horizontalPadding = 12
  const charWidth = Math.max(6.5, fontSize * 0.6)
  return Math.floor(Math.max(0, host.clientWidth - horizontalPadding) / charWidth)
}

/** 按容器宽度计算列数，并夹在 [minCols, maxCols]；有 savedCols 时取 min(saved, 宽度列) */
export function resolveTerminalCols(
  fit: FitAddon,
  host: HTMLElement | null | undefined,
  options: SafeFitTerminalOptions = {}
): number {
  const maxCols = options.maxCols ?? SHELL_TERMINAL_COLS
  const minCols = options.minCols ?? SHELL_TERMINAL_MIN_COLS
  const fontSize = options.fontSize ?? SHELL_TERMINAL_FONT_SIZE

  let widthCols = maxCols
  if (isTerminalHostReady(host) && host) {
    try {
      const dims = fit.proposeDimensions()
      if (dims?.cols && Number.isFinite(dims.cols)) {
        widthCols = Math.floor(dims.cols)
      } else {
        widthCols = estimateTerminalColsFromWidth(host, fontSize)
      }
    } catch {
      widthCols = estimateTerminalColsFromWidth(host, fontSize)
    }
  }

  widthCols = Math.min(maxCols, Math.max(minCols, widthCols))

  if (options.savedCols != null && options.savedCols > 0) {
    return Math.min(options.savedCols, widthCols)
  }
  return widthCols
}

/**
 * 按容器宽高适配终端：列数随宽度变化（上限 80），行数随高度变化。
 * open() 后若字体未就绪，proposeDimensions() 可能为 undefined，此时用容器宽度估算列数，
 * 避免固定 80 列在窄面板出现横向滚动条，也避免缩到 ~30 列导致进度条错位。
 */
export function safeFitTerminalRows(
  term: Terminal,
  fit: FitAddon,
  host: HTMLElement | null | undefined,
  options: SafeFitTerminalOptions = {}
): void {
  try {
    const cols = resolveTerminalCols(fit, host, options)
    if (!isTerminalHostReady(host)) {
      forceTerminalCols(term, cols)
      return
    }

    const dims = fit.proposeDimensions()
    const rows =
      dims && Number.isFinite(dims.rows) ? Math.max(1, Math.floor(dims.rows)) : Math.max(1, term.rows)

    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows)
    }
  } catch {
    /* 竞态：终端已 dispose 或 renderer 未就绪 */
  }
}

/** write 包一层，避免 disposed / renderer 未就绪时抛错 */
export function safeWriteTerminal(term: Terminal, data: string | Uint8Array): void {
  try {
    term.write(data)
  } catch {
    /* disposed 或 renderer 未就绪 */
  }
}

export type TerminalRawWriteState = { writtenTextLen: number; cols: number }

/** 清空并重放 live progress（base64 raw tail） */
export function replayTerminalRaw(
  term: Terminal,
  rawB64: string | undefined,
  options?: { followBottom?: boolean }
): void {
  const payload = decodeProgressRawTailForXterm(rawB64)
  try {
    term.clear()
    if (payload.length > 0) safeWriteTerminal(term, payload)
    if (options?.followBottom !== false) {
      term.scrollToBottom()
    }
  } catch {
    /* disposed */
  }
}

/** 增量写入 raw tail（保留 \\r 进度条语义，避免每次 clear 全量重放） */
export function appendTerminalRawProgress(
  term: Terminal,
  rawB64: string | undefined,
  state: TerminalRawWriteState,
  options?: { followBottom?: boolean }
): TerminalRawWriteState {
  const full = decodeProgressRawTailForXterm(rawB64)
  const cols = term.cols

  if (cols !== state.cols || full.length < state.writtenTextLen) {
    replayTerminalRaw(term, rawB64, options)
    return { writtenTextLen: full.length, cols }
  }

  if (full.length > state.writtenTextLen) {
    safeWriteTerminal(term, full.slice(state.writtenTextLen))
    if (options?.followBottom !== false) {
      try {
        term.scrollToBottom()
      } catch {
        /* disposed */
      }
    }
    return { writtenTextLen: full.length, cols }
  }

  return { ...state, cols }
}

/** 恢复完成态 scrollback（serialized / ansi 明文，非 base64） */
export function restoreTerminalScrollbackPayload(
  term: Terminal,
  payload: string | undefined,
  kind: 'serialized' | 'ansi'
): void {
  if (!payload) return
  try {
    term.clear()
    const text = kind === 'ansi' ? normalizeXtermPipeInput(payload) : payload
    safeWriteTerminal(term, text)
  } catch {
    /* disposed */
  }
}

/**
 * 延迟 dispose，让 xterm Viewport 内 pending 的 syncScrollArea 先跑完。
 * open() 后 Viewport 会 setTimeout/rAF 触发 syncScrollArea；若同步 dispose 会读到 undefined dimensions。
 */
export function deferDisposeTerminal(term: Terminal | null | undefined): void {
  if (!term) return
  const win = term.element?.ownerDocument?.defaultView ?? window
  win.requestAnimationFrame(() => {
    try {
      term.dispose()
    } catch {
      /* ignore */
    }
  })
}

/** 绑定选区复制（Ctrl/Cmd+C、copy 事件）；只读终端 disableStdin 时系统 copy 常失效 */
export function attachShellTerminalCopy(term: Terminal): { dispose: () => void } {
  const el = term.element
  if (!el) return { dispose: () => {} }

  const writeClipboard = (text: string): void => {
    if (!text) return
    void navigator.clipboard.writeText(text).catch(() => {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        /* ignore */
      }
    })
  }

  const handler = (event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown') return true
    const mod = event.ctrlKey || event.metaKey
    if (!mod || event.key.toLowerCase() !== 'c' || !term.hasSelection()) return true
    writeClipboard(term.getSelection())
    return false
  }

  term.attachCustomKeyEventHandler(handler)

  const onCopy = (event: ClipboardEvent) => {
    if (!term.hasSelection()) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', term.getSelection())
  }

  el.addEventListener('copy', onCopy)

  return {
    dispose: () => {
      term.attachCustomKeyEventHandler(() => true)
      el.removeEventListener('copy', onCopy)
    }
  }
}

/** 双 rAF 延迟挂载，规避 React Strict Mode 快速 mount/unmount 与 renderer 未就绪 */
export function scheduleTerminalMount(mount: () => void): () => void {
  let outerRaf: number | null = requestAnimationFrame(() => {
    outerRaf = null
    innerRaf = requestAnimationFrame(() => {
      innerRaf = null
      mount()
    })
  })
  let innerRaf: number | null = null
  return () => {
    if (outerRaf !== null) cancelAnimationFrame(outerRaf)
    if (innerRaf !== null) cancelAnimationFrame(innerRaf)
  }
}
