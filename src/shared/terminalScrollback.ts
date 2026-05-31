import type { ShellTerminalScrollback } from './domainTypes'

export const SCROLLBACK_MAX_BYTES = 256 * 1024
export const PROGRESS_RAW_MAX_BYTES = 64 * 1024

export type TerminalExportSource = {
  cols: number
  rows: number
  serialize?: () => string
  getAnsiText?: () => string
  getPlainText?: () => string
}

export function truncateScrollbackExport(
  scrollback: ShellTerminalScrollback
): ShellTerminalScrollback & { truncated?: boolean } {
  const fields: Array<keyof Pick<ShellTerminalScrollback, 'serialized' | 'ansiText' | 'plainText'>> = [
    'serialized',
    'ansiText',
    'plainText'
  ]
  const byteLen = (s: string) => new TextEncoder().encode(s).length
  let total = 0
  for (const key of fields) {
    const v = scrollback[key]
    if (typeof v === 'string') total += byteLen(v)
  }
  if (total <= SCROLLBACK_MAX_BYTES) return scrollback

  const ratio = SCROLLBACK_MAX_BYTES / total
  const out: ShellTerminalScrollback & { truncated?: boolean } = {
    cols: scrollback.cols,
    rows: scrollback.rows,
    truncated: true
  }
  for (const key of fields) {
    const v = scrollback[key]
    if (typeof v !== 'string') continue
    const keep = Math.max(0, Math.floor(v.length * ratio))
    out[key] = keep > 0 ? v.slice(-keep) : undefined
  }
  return out
}

export function exportTerminalScrollback(source: TerminalExportSource): ShellTerminalScrollback {
  const base: ShellTerminalScrollback = {
    cols: source.cols,
    rows: source.rows
  }
  try {
    const serialized = source.serialize?.()
    if (serialized) base.serialized = serialized
  } catch {
    /* SerializeAddon may fail on empty buffer */
  }
  const ansiText = source.getAnsiText?.()
  if (ansiText) base.ansiText = ansiText
  const plainText = source.getPlainText?.()
  if (plainText) base.plainText = plainText
  return truncateScrollbackExport(base)
}

/** 追加原始字节 tail，保留尾部 PROGRESS_RAW_MAX_BYTES */
export function appendProgressRawBytes(prev: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.length === 0) return prev
  const combined = new Uint8Array(prev.length + chunk.length)
  combined.set(prev, 0)
  combined.set(chunk, prev.length)
  if (combined.length <= PROGRESS_RAW_MAX_BYTES) return combined
  return combined.subarray(combined.length - PROGRESS_RAW_MAX_BYTES)
}

export function encodeProgressRawBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

export function appendProgressOutputRaw(prev: string | undefined, chunkB64: string): string {
  const prevBytes = decodeProgressRawTail(prev)
  const chunkBytes = decodeProgressRawTail(chunkB64)
  return encodeProgressRawBytes(appendProgressRawBytes(prevBytes, chunkBytes))
}

export function decodeProgressRawTail(rawB64: string | undefined): Uint8Array {
  if (!rawB64) return new Uint8Array(0)
  try {
    const binary = atob(rawB64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
}

/**
 * pipe 子进程（尤其 Windows）常只输出 LF；xterm 默认 LF 仅下移光标、不回列首，会出现阶梯式缩进。
 * 将独立 LF 规范为 CRLF，保留已有 CRLF 与单行 \r 进度条语义。
 */
export function normalizeXtermPipeInput(text: string): string {
  if (!text) return ''
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\n' && (i === 0 || text[i - 1] !== '\r')) {
      out += '\r\n'
    } else {
      out += ch
    }
  }
  return out
}

export function decodeProgressRawTailForXterm(rawB64: string | undefined): string {
  const bytes = decodeProgressRawTail(rawB64)
  if (bytes.length === 0) return ''
  return normalizeXtermPipeInput(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
}

export function pickScrollbackRestorePayload(
  scrollback: ShellTerminalScrollback | undefined
): { kind: 'serialized' | 'ansi' | 'plain' | 'none'; payload?: string } {
  if (!scrollback) return { kind: 'none' }
  if (scrollback.serialized?.trim()) return { kind: 'serialized', payload: scrollback.serialized }
  if (scrollback.ansiText?.trim()) return { kind: 'ansi', payload: scrollback.ansiText }
  if (scrollback.plainText?.trim()) return { kind: 'plain', payload: scrollback.plainText }
  return { kind: 'none' }
}
