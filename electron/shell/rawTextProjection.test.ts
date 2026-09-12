import { describe, expect, it } from 'vitest'
import type { RawByteSnapshot } from './boundedOutput'
import { decodeRawSlice, decoderFamily, projectRawText, projectRawTextWithAlignment } from './rawTextProjection'

/** GBK「中文测试ABC」的原始字节；Node 没有 GBK 编码器，用十六进制固定样本。 */
const GBK_SAMPLE = Buffer.from('D6D0CEC4B2E2CAD4414243', 'hex')
/** UTF-16LE「中文测试ABC」。 */
const UTF16_SAMPLE = Buffer.from('中文测试ABC', 'utf16le')
/** UTF-8「中文测试ABC」。 */
const UTF8_SAMPLE = Buffer.from('中文测试ABC', 'utf8')

function snapshotOf(head: Buffer, tail: Buffer, totalBytes: number): RawByteSnapshot {
  return {
    head,
    tail,
    totalBytes,
    retainedBytes: head.length + tail.length,
    omittedBytes: Math.max(0, totalBytes - head.length - tail.length),
    truncated: true
  }
}

describe('decoderFamily', () => {
  it('按编码族分类，未知标签按多字节保守处理', () => {
    expect(decoderFamily('utf-8')).toBe('utf-8')
    expect(decoderFamily('utf-16le')).toBe('utf-16')
    expect(decoderFamily('utf-16be')).toBe('utf-16')
    expect(decoderFamily('windows-1252')).toBe('single-byte')
    expect(decoderFamily('koi8-r')).toBe('single-byte')
    expect(decoderFamily('koi8-u')).toBe('single-byte')
    expect(decoderFamily('gbk')).toBe('multibyte')
    expect(decoderFamily('shift_jis')).toBe('multibyte')
    expect(decoderFamily('some-future-codec')).toBe('multibyte')
  })
})

describe('decodeRawSlice', () => {
  it('UTF-8 tail 从多字节字符中间截断时按续字节对齐，且不标记不确定', () => {
    const result = decodeRawSlice('utf-8', UTF8_SAMPLE.subarray(4), 'tail', 4)
    expect(result.text).toBe('测试ABC')
    expect(result.uncertain).toBe(false)
  })

  it('UTF-16LE tail 按 2 字节对齐，奇数偏移不再错位配对', () => {
    const result = decodeRawSlice('utf-16le', UTF16_SAMPLE.subarray(3), 'tail', 3)
    expect(result.text).toBe('测试ABC')
    expect(result.uncertain).toBe(false)
  })

  it('UTF-16LE tail 偶数偏移直接解码', () => {
    const result = decodeRawSlice('utf-16le', UTF16_SAMPLE.subarray(4), 'tail', 4)
    expect(result.text).toBe('测试ABC')
    expect(result.uncertain).toBe(false)
  })

  it('GBK tail 无法自证 lead byte 对齐时标记 uncertain，不再按「首字符非 U+FFFD」静默放行', () => {
    // 从字节 5 切：C4 是「文」的 trail byte，错位解码会得到「牟馐訟BC」这类合法但错误的文本
    const result = decodeRawSlice('gbk', GBK_SAMPLE.subarray(5), 'tail', 5)
    expect(result.uncertain).toBe(true)
    expect(decoderFamily('gbk')).toBe('multibyte')
  })

  it('多字节编码的纯 ASCII 切片不含多字节字符，不标记不确定', () => {
    const result = decodeRawSlice('gbk', Buffer.from('plain ascii tail', 'ascii'), 'tail', 5)
    expect(result.uncertain).toBe(false)
    expect(result.text).toBe('plain ascii tail')
  })

  it('单字节编码 tail 永不标记不确定', () => {
    const result = decodeRawSlice('windows-1252', Buffer.from('abcd', 'latin1'), 'tail', 2)
    expect(result.uncertain).toBe(false)
  })

  it('head 边缘按宽容严格解码，从不标记不确定', () => {
    const result = decodeRawSlice('gbk', GBK_SAMPLE.subarray(0, 5), 'head', 0)
    expect(result.uncertain).toBe(false)
    expect(result.text).toBe('中文')
  })

  it('空切片返回空文本且不标记不确定', () => {
    expect(decodeRawSlice('gbk', Buffer.alloc(0), 'tail', 0)).toEqual({ text: '', uncertain: false })
  })
})

describe('projectRawText 对齐标记', () => {
  it('GBK 截断投影标记 alignmentUncertain，文本仍是最佳努力投影', () => {
    const snapshot = snapshotOf(GBK_SAMPLE.subarray(0, 4), GBK_SAMPLE.subarray(5), GBK_SAMPLE.length)
    const projected = projectRawTextWithAlignment(snapshot, 'gbk')
    expect(projected.alignmentUncertain).toBe(true)
    expect(projectRawText(snapshot, 'gbk')).toBe(projected.text)
    expect(projected.text).toContain('[… output truncated …]')
  })

  it('UTF-8 截断投影不标记不确定', () => {
    const bytes = Buffer.from('中文测试ABC中文测试ABC', 'utf8')
    const snapshot = snapshotOf(bytes.subarray(0, 9), bytes.subarray(10), bytes.length)
    expect(projectRawTextWithAlignment(snapshot, 'utf-8').alignmentUncertain).toBe(false)
  })

  it('未截断时不标记不确定', () => {
    const snapshot = snapshotOf(GBK_SAMPLE, Buffer.alloc(0), GBK_SAMPLE.length)
    const projected = projectRawTextWithAlignment(snapshot, 'gbk')
    expect(projected.alignmentUncertain).toBe(false)
    expect(projected.text).toBe('中文测试ABC')
  })
})
