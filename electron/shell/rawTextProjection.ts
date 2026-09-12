import type { RawByteSnapshot } from './boundedOutput'
import { TRUNCATION_MARKER, rawSnapshotBuffer } from './boundedOutput'
import { decodeStrictTolerant, decodeWithLabel, hasNonAscii } from '../processOutput/detectEncoding'

export type DecoderFamily = 'utf-8' | 'utf-16' | 'single-byte' | 'multibyte'

/** 单字节编码：任何字节边界都是字符边界，截断切片不可能错位。 */
const SINGLE_BYTE_LABEL_RE = /^(?:windows-125\d|windows-874|ibm866|koi8-[ru]|iso-8859-\d+|ascii|us-ascii|latin1)$/

/**
 * 解码器族分类（§9.3）。未知标签按 `multibyte` 保守处理：
 * 猜错的代价是把「合法但错误」的文本当成真值交付，比多标一次可疑严重得多。
 */
export function decoderFamily(label: string): DecoderFamily {
  const normalized = label.trim().toLowerCase()
  if (normalized === 'utf-8' || normalized === 'utf8') return 'utf-8'
  if (normalized === 'utf-16' || normalized === 'utf-16le' || normalized === 'utf-16be') return 'utf-16'
  if (SINGLE_BYTE_LABEL_RE.test(normalized)) return 'single-byte'
  return 'multibyte'
}

export interface SlicedDecode {
  text: string
  /** 切片起点是否可能落在字符中间且无法自证：上层必须按可疑输出降级处理。 */
  uncertain: boolean
}

function skipUtf8ContinuationBytes(buf: Buffer): number {
  let skip = 0
  while (skip < 3 && skip < buf.length && (buf[skip]! & 0xc0) === 0x80) skip += 1
  return skip
}

/**
 * 从原始字节切片的边缘解码：head 允许末尾有多字节残段，tail 允许开头有多字节残段。
 *
 * tail 的起点是「流中间」的任意字节边界，必须按编码族对齐裁剪：
 * - UTF-8 自同步：跳过开头的续字节即可精确定位字符起点；
 * - UTF-16：用起点在流中的绝对偏移按 2 字节对齐；
 * - 单字节编码：不存在错位；
 * - GBK/Big5/Shift_JIS 等多字节非自同步编码：首字节究竟是完整字符还是被丢弃字符的
 *   trail byte，仅凭切片无法判定（同一串字节按 ±1 偏移都能解出「合法」文本，实测
 *   GBK 错位会得到「形牟馐訟BC」这类伪文本）。旧实现用「首字符是否 U+FFFD」试探偏移，
 *   只对 UTF-8 成立，对 GBK/UTF-16 会静默交付错位文本。现在不再猜测，改为标记
 *   `uncertain`，由上层把该流降级为可疑输出（保留原文 + 产出 rawArtifact）。
 */
export function decodeRawSlice(label: string, buf: Buffer, edge: 'head' | 'tail', streamOffset = 0): SlicedDecode {
  if (buf.length === 0) return { text: '', uncertain: false }
  if (edge === 'head') {
    return { text: decodeStrictTolerant(label, buf) ?? decodeWithLabel(label, buf), uncertain: false }
  }
  const family = decoderFamily(label)
  if (family === 'utf-8') {
    return { text: decodeWithLabel(label, buf.subarray(skipUtf8ContinuationBytes(buf))), uncertain: false }
  }
  if (family === 'utf-16') {
    const skip = ((streamOffset % 2) + 2) % 2
    return { text: decodeWithLabel(label, buf.subarray(skip)), uncertain: false }
  }
  if (family === 'single-byte') {
    return { text: decodeWithLabel(label, buf), uncertain: false }
  }
  // 切片全为 ASCII 时不存在多字节字符（这类编码均 ASCII 兼容），不必误判为可疑。
  return { text: decodeWithLabel(label, buf), uncertain: hasNonAscii(buf) }
}

export interface RawTextProjection {
  text: string
  /** 截断切片的字符对齐无法确认；上层据此把该流标为可疑（§8.4）。 */
  alignmentUncertain: boolean
}

/** 文本投影 = 解码(head) + marker + 解码(tail)（§9.3）。 */
export function projectRawTextWithAlignment(snapshot: RawByteSnapshot, label: string): RawTextProjection {
  const whole = rawSnapshotBuffer(snapshot)
  if (whole) return { text: decodeWithLabel(label, whole), alignmentUncertain: false }
  const head = decodeRawSlice(label, snapshot.head, 'head', 0)
  const tail = decodeRawSlice(label, snapshot.tail, 'tail', snapshot.totalBytes - snapshot.tail.length)
  return {
    text: `${head.text}${TRUNCATION_MARKER}${tail.text}`,
    alignmentUncertain: head.uncertain || tail.uncertain
  }
}

export function projectRawText(snapshot: RawByteSnapshot, label: string): string {
  return projectRawTextWithAlignment(snapshot, label).text
}
