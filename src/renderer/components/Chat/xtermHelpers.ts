import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { decodeProgressRawTailForXterm, normalizeXtermPipeInput } from '../../../shared/terminalScrollback'
import { SHELL_TERMINAL_COLS } from './terminalTheme'

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

/**
 * 仅按容器高度适配行数，列数保持固定。
 * open() 后若字体未就绪，proposeDimensions() 会返回 undefined，此时也必须强制 cols，
 * 否则 xterm 会按容器宽度缩到 ~30 列，长行被错误折行。
 */
export function safeFitTerminalRows(
  term: Terminal,
  fit: FitAddon,
  host: HTMLElement | null | undefined,
  fixedCols: number = SHELL_TERMINAL_COLS
): void {
  try {
    forceTerminalCols(term, fixedCols)
    if (!isTerminalHostReady(host)) return

    const dims = fit.proposeDimensions()
    const rows =
      dims && Number.isFinite(dims.rows) ? Math.max(1, Math.floor(dims.rows)) : Math.max(1, term.rows)
    if (term.rows !== rows || term.cols !== fixedCols) {
      term.resize(fixedCols, rows)
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
