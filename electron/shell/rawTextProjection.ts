import type { RawByteSnapshot } from './boundedOutput'
import { TRUNCATION_MARKER, rawSnapshotBuffer } from './boundedOutput'
import { decodeStrictTolerant, decodeWithLabel } from '../processOutput/detectEncoding'

/**
 * 从原始字节切片的边缘解码：head 允许末尾有多字节残段，tail 允许开头有多字节残段。
 * 只有真正判错的字节才会落到 U+FFFD，边界截断不会。
 */
export function decodeRawSlice(label: string, buf: Buffer, edge: 'head' | 'tail'): string {
  if (buf.length === 0) return ''
  if (edge === 'head') return decodeStrictTolerant(label, buf) ?? decodeWithLabel(label, buf)
  const limit = Math.min(3, buf.length - 1)
  for (let offset = 0; offset <= limit; offset += 1) {
    const text = decodeWithLabel(label, buf.subarray(offset))
    if (text.length > 0 && text.charCodeAt(0) !== 0xfffd) return text
  }
  return decodeWithLabel(label, buf)
}

/** 文本投影 = 解码(head) + marker + 解码(tail)（§9.3）。 */
export function projectRawText(snapshot: RawByteSnapshot, label: string): string {
  const whole = rawSnapshotBuffer(snapshot)
  if (whole) return decodeWithLabel(label, whole)
  return `${decodeRawSlice(label, snapshot.head, 'head')}${TRUNCATION_MARKER}${decodeRawSlice(label, snapshot.tail, 'tail')}`
}
