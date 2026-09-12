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

/** 取尾部 keep 个码元；起点若落在低位代理上则丢掉它（避免孤立代理渲染成 U+FFFD）。 */
export function tailWithoutLoneSurrogate(value: string, keep: number): string {
  if (keep <= 0) return ''
  const tail = value.slice(-keep)
  const first = tail.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail
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
    // MINOR：起点若落在低位代理上，丢掉它，避免留下孤立代理对半（渲染成 U+FFFD）。
    const tail = tailWithoutLoneSurrogate(v, keep)
    out[key] = tail.length > 0 ? tail : undefined
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

/**
 * 终端文本投影（§12-#11）：终端本体始终是「原始字节 → xterm」，本函数只服务
 * 需要文本投影的调用方（回滚/长度统计）。编码标签由调用方按当前 shell 契约传入，
 * 缺省 utf-8 只作为无契约信息时的兼容值。
 */
export function decodeProgressRawTailForXterm(rawB64: string | undefined, label = 'utf-8'): string {
  const bytes = decodeProgressRawTail(rawB64)
  if (bytes.length === 0) return ''
  return normalizeXtermPipeInput(decodeBytesForXterm(bytes, label))
}

/** 非法/未知标签不允许打断终端渲染：退回 UTF-8（与 xterm 默认一致）。 */
function decodeBytesForXterm(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label || 'utf-8', { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
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
