import { describe, expect, it } from 'vitest'
import { RawByteBuffer } from './boundedOutput'
import { createOutputPipelineSnapshot } from './outputPipeline'
import { projectRawText } from './rawTextProjection'

function bytesOf(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

function snapshotOf(chunks: readonly string[], limit: number): ReturnType<RawByteBuffer['snapshotBytes']> {
  const buffer = new RawByteBuffer(limit)
  for (const chunk of chunks) buffer.appendBytes(bytesOf(chunk))
  return buffer.snapshotBytes()
}

describe('RawByteBuffer', () => {
  it('保留前 limit 字节与后 limit/2 字节，并统计被省略的原始字节数', () => {
    const snapshot = snapshotOf(['0123456789', 'abcdefghij'], 8)
    expect(snapshot.totalBytes).toBe(20)
    expect(snapshot.head.toString('utf8')).toBe('01234567')
    expect(snapshot.tail.toString('utf8')).toBe('ghij')
    expect(snapshot.omittedBytes).toBe(8)
    expect(snapshot.truncated).toBe(true)
  })

  it('未超过上限时不截断且 head+tail 就是完整流', () => {
    const snapshot = snapshotOf(['hello', ' world'], 32)
    expect(snapshot.totalBytes).toBe(11)
    expect(snapshot.omittedBytes).toBe(0)
    expect(snapshot.truncated).toBe(false)
    expect(projectRawText(snapshot, 'utf-8')).toBe('hello world')
  })

  it('100MB 连续输出时快照保持有界且完整统计总字节数', () => {
    const buffer = new RawByteBuffer(1024)
    const chunk = Buffer.alloc(1024 * 1024, 120)
    for (let i = 0; i < 100; i += 1) buffer.appendBytes(chunk)
    const snapshot = buffer.snapshotBytes()
    expect(snapshot.totalBytes).toBe(100 * 1024 * 1024)
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(1536)
    expect(snapshot.truncated).toBe(true)
  })

  it('MINOR：totalBytes getter 不构造快照即可读取累计字节数', () => {
    const buffer = new RawByteBuffer(8)
    buffer.appendBytes(bytesOf('0123456789'))
    buffer.appendBytes(bytesOf('abc'))
    expect(buffer.totalBytes).toBe(13)
    // getter 与快照口径必须一致
    expect(buffer.totalBytes).toBe(buffer.snapshotBytes().totalBytes)
  })

  it('多字节字符跨截断边界时不会在投影里产生 U+FFFD', () => {
    const snapshot = snapshotOf(['前缀', '中间内容', '尾部'], 8)
    const text = projectRawText(snapshot, 'utf-8')
    expect(text).not.toContain('\uFFFD')
    expect(text).toContain('[… output truncated …]')
  })
})

describe('createOutputPipelineSnapshot', () => {
  it('统一原始字节快照、文本投影、terminal raw 和 artifact 元数据，并冻结快照', () => {
    const stdout = snapshotOf(['head'], 1024)
    const stderr = snapshotOf(['err'], 1024)
    const snapshot = createOutputPipelineSnapshot({
      stdout,
      stderr,
      stdoutLabel: 'utf-8',
      stderrLabel: 'utf-8',
      terminalRaw: Buffer.from('raw'),
      inlineMaxBytes: 1024,
      artifactMaxBytes: 2048,
      artifact: { path: '/tmp/out.log', bytes: 103, sha256: 'a'.repeat(64) }
    })
    expect(snapshot).toMatchObject({
      stdoutText: 'head',
      stderrText: 'err',
      terminalRawBytes: 3,
      terminalRawBase64: 'cmF3',
      truncated: false
    })
    expect(snapshot.artifact?.bytes).toBe(103)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.stdout)).toBe(true)
  })

  it('GBK 截断切片的对齐不确定会透传给上层（M1：不再静默交付错位文本）', () => {
    const gbk = Buffer.from('D6D0CEC4B2E2CAD4414243'.repeat(5), 'hex')
    const snapshot = createOutputPipelineSnapshot({
      stdout: { head: gbk.subarray(0, 32), tail: gbk.subarray(39), totalBytes: gbk.length, retainedBytes: 48, omittedBytes: 7, truncated: true },
      stderr: snapshotOf(['err'], 1024),
      stdoutLabel: 'gbk',
      stderrLabel: 'utf-8',
      inlineMaxBytes: 32,
      artifactMaxBytes: 2048
    })
    expect(snapshot.stdoutAlignmentUncertain).toBe(true)
    expect(snapshot.stderrAlignmentUncertain).toBe(false)
    expect(snapshot.stdoutText).toContain('[… output truncated …]')
  })

  it('UTF-8 截断切片的对齐可精确恢复，不标记不确定', () => {
    const bytes = Buffer.from('中文测试ABC'.repeat(5), 'utf8')
    const snapshot = createOutputPipelineSnapshot({
      stdout: { head: bytes.subarray(0, 32), tail: bytes.subarray(39), totalBytes: bytes.length, retainedBytes: 48, omittedBytes: bytes.length - 48, truncated: true },
      stderr: snapshotOf([], 1024),
      stdoutLabel: 'utf-8',
      stderrLabel: 'utf-8',
      inlineMaxBytes: 32,
      artifactMaxBytes: 2048
    })
    expect(snapshot.stdoutAlignmentUncertain).toBe(false)
    expect(snapshot.stdoutText).not.toContain('\uFFFD')
  })
})
