import { describe, expect, it } from 'vitest'
import {
  appendProgressOutputRaw,
  appendProgressRawBytes,
  decodeProgressRawTail,
  decodeProgressRawTailForXterm,
  encodeProgressRawBytes,
  exportTerminalScrollback,
  normalizeXtermPipeInput,
  pickScrollbackRestorePayload,
  truncateScrollbackExport,
  SCROLLBACK_MAX_BYTES,
  PROGRESS_RAW_MAX_BYTES
} from './terminalScrollback'

describe('terminalScrollback', () => {
  it('exports serialized and ansi fallbacks', () => {
    const out = exportTerminalScrollback({
      cols: 80,
      rows: 24,
      serialize: () => 'serialized-data',
      getAnsiText: () => 'ansi-line',
      getPlainText: () => 'plain-line'
    })
    expect(out.serialized).toBe('serialized-data')
    expect(out.ansiText).toBe('ansi-line')
    expect(out.plainText).toBe('plain-line')
    expect(out.cols).toBe(80)
  })

  it('truncates oversized scrollback', () => {
    const big = 'x'.repeat(SCROLLBACK_MAX_BYTES + 1000)
    const out = truncateScrollbackExport({
      cols: 80,
      rows: 24,
      serialized: big
    })
    expect(out.truncated).toBe(true)
    expect((out.serialized?.length ?? 0)).toBeLessThan(big.length)
  })

  it('appends raw tail with byte cap', () => {
    const chunk = Buffer.from('abc').toString('base64')
    const prev = Buffer.alloc(70 * 1024, 1).toString('base64')
    const next = appendProgressOutputRaw(prev, chunk)
    const approxBytes = Math.ceil((next.length * 3) / 4)
    expect(approxBytes).toBeLessThanOrEqual(64 * 1024 + 16)
    expect(decodeProgressRawTail(next).length).toBeLessThanOrEqual(PROGRESS_RAW_MAX_BYTES)
  })

  it('round-trips multi-chunk raw tail as single valid base64', () => {
    const hello = new TextEncoder().encode('hello')
    const world = new TextEncoder().encode(' world')
    let tail = new Uint8Array(0)
    tail = appendProgressRawBytes(tail, hello)
    tail = appendProgressRawBytes(tail, world)
    const encoded = encodeProgressRawBytes(tail)
    expect(new TextDecoder().decode(decodeProgressRawTail(encoded))).toBe('hello world')
  })

  it('does not treat concatenated base64 strings as valid raw tail', () => {
    const broken = Buffer.from('hello').toString('base64') + Buffer.from(' world').toString('base64')
    expect(decodeProgressRawTail(broken)).toEqual(new Uint8Array(0))
  })

  it('normalizes lone LF for xterm pipe display', () => {
    expect(normalizeXtermPipeInput('line1\nline2')).toBe('line1\r\nline2')
    expect(normalizeXtermPipeInput('line1\r\nline2')).toBe('line1\r\nline2')
    expect(normalizeXtermPipeInput('10%\r50%')).toBe('10%\r50%')
  })

  it('decodes raw tail as xterm-safe string', () => {
    const raw = Buffer.from('pw:install\nnext').toString('base64')
    expect(decodeProgressRawTailForXterm(raw)).toBe('pw:install\r\nnext')
  })

  it('picks restore payload priority', () => {
    expect(pickScrollbackRestorePayload({ cols: 80, rows: 24, serialized: 's' }).kind).toBe('serialized')
    expect(pickScrollbackRestorePayload({ cols: 80, rows: 24, ansiText: 'a' }).kind).toBe('ansi')
    expect(pickScrollbackRestorePayload({ cols: 80, rows: 24, plainText: 'p' }).kind).toBe('plain')
  })
})
