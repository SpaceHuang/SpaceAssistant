import { describe, expect, it } from 'vitest'
import { createLineSplitter } from './lineSplitter'
import { AUTO_CONTRACT, UTF8_CONTRACT } from './contracts'
import { isClixmlPayload, stripClixmlWrapper } from './clixml'

const WIN = 'win32' as NodeJS.Platform

describe('lineSplitter', () => {
  it('T12 中文 JSON 行按任意位置切开仍输出完整行且无 U+FFFD', () => {
    const lines = [
      JSON.stringify({ level: 'error', message: '连接失败：无法解析响应' }),
      JSON.stringify({ level: 'info', message: '会话已建立' })
    ]
    const payload = Buffer.from(lines.join('\n') + '\n', 'utf8')
    for (const size of [1, 2, 3, 5, 17, payload.length]) {
      const splitter = createLineSplitter({ contract: UTF8_CONTRACT, platform: WIN })
      const out: string[] = []
      for (let offset = 0; offset < payload.length; offset += size) {
        out.push(...splitter.write(payload.subarray(offset, offset + size)))
      }
      out.push(...splitter.end())
      expect(out, `chunkSize=${size}`).toEqual(lines)
      expect(out.join(''), `chunkSize=${size}`).not.toContain('\uFFFD')
    }
  })

  it('CRLF 行与末尾无换行的残行都被正确交付', () => {
    const splitter = createLineSplitter({ contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    const out = [...splitter.write(Buffer.from('a\r\nb\r\npartial', 'utf8')), ...splitter.end()]
    expect(out).toEqual(['a', 'b', 'partial'])
  })

  it('空输入不产出任何行', () => {
    const splitter = createLineSplitter({ contract: UTF8_CONTRACT, platform: WIN })
    expect(splitter.write(Buffer.alloc(0))).toEqual([])
    expect(splitter.end()).toEqual([])
  })
})

describe('stripClixmlWrapper', () => {
  it('非 CLIXML 文本原样返回', () => {
    expect(stripClixmlWrapper('plain stderr')).toBe('plain stderr')
    expect(isClixmlPayload('plain stderr')).toBe(false)
  })

  it('剥离 CLIXML 包装并还原 _xNNNN_ 转义', () => {
    const payload = '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress"><S S="Error">boom_x000D__x000A_</S></Obj></Objs>'
    expect(isClixmlPayload(payload)).toBe(true)
    expect(stripClixmlWrapper(payload)).toBe('boom\r\n')
  })

  it('只有头部但没有错误流时保持原文，避免静默丢信息', () => {
    const payload = '#< CLIXML\n<Objs Version="1.1.0.1"></Objs>'
    expect(stripClixmlWrapper(payload)).toBe(payload)
  })
})
