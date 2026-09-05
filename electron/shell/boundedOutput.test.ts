import { describe, expect, it } from 'vitest'
import { BoundedOutputBuffer } from './boundedOutput'

describe('BoundedOutputBuffer', () => {
  it('在输出增长时只保留有界首尾内容并统计完整字节数', () => {
    const buffer = new BoundedOutputBuffer(16, 6)
    buffer.append('0123456789')
    buffer.append('abcdefghij')

    const result = buffer.snapshot()
    expect(result.bytes).toBe(20)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16)
    expect(result.text.startsWith('012345')).toBe(true)
    expect(result.text).toContain('efghij')
  })

  it('支持 Buffer chunk 和 UTF-8 多字节字符，不切出替换字符', () => {
    const buffer = new BoundedOutputBuffer(12, 6)
    buffer.append(Buffer.from('前缀'))
    buffer.append(Buffer.from('中间内容'))
    buffer.append(Buffer.from('尾部'))

    const result = buffer.snapshot()
    expect(result.bytes).toBe(Buffer.byteLength('前缀中间内容尾部'))
    expect(result.text).not.toContain('�')
  })

  it('处理 100MB 连续输出时 snapshot 保持有界且完整统计总字节数', () => {
    const output = new BoundedOutputBuffer(1024)
    const chunk = Buffer.alloc(1024 * 1024, 120)
    for (let i = 0; i < 100; i += 1) output.append(chunk)
    const snapshot = output.snapshot()
    expect(snapshot.bytes).toBe(100 * 1024 * 1024)
    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(1024)
    expect(snapshot.truncated).toBe(true)
  })

  it('未超过限制时不标记截断且保留原文', () => {
    const buffer = new BoundedOutputBuffer(32)
    buffer.append('hello')
    expect(buffer.snapshot()).toEqual({ text: 'hello', bytes: 5, truncated: false })
  })
})
