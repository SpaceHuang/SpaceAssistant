import { describe, expect, it } from 'vitest'
import {
  ACCIDENT_BYTES,
  ACCIDENT_TEXT,
  GBK_ZH_TEST_BARE_HEX,
  UTF16BE_PURE_CJK_SHORT_HEX,
  UTF16LE_PURE_CJK_HEX
} from './testFixtures'
import { AUTO_CONTRACT, UTF8_CONTRACT, oemContract } from './contracts'
import { createChildStreamDecoder, decodeChildOutput } from './decodeChildOutput'

const WIN = 'win32' as NodeJS.Platform

function streamAll(chunks: readonly Buffer[], options: Parameters<typeof createChildStreamDecoder>[0]): { text: string; meta: ReturnType<typeof createChildStreamDecoder>['meta']; locked: boolean } {
  const decoder = createChildStreamDecoder(options)
  let text = ''
  for (const chunk of chunks) text += decoder.write(chunk)
  text += decoder.end()
  return { text, meta: decoder.meta, locked: decoder.locked }
}

function split(buf: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < buf.length; offset += size) chunks.push(buf.subarray(offset, offset + size))
  return chunks
}

describe('decodeChildOutput 一次性入口', () => {
  it('MINOR：空缓冲在 auto 契约下不再自称 source=contract', () => {
    const auto = decodeChildOutput(Buffer.alloc(0), { contract: AUTO_CONTRACT })
    expect(auto.meta.encoding).toBe('utf-8')
    expect(auto.meta.source).toBe('strict-utf8')
    expect(auto.text).toBe('')
    expect(auto.weakEvidence).toBe(false)

    const oem = decodeChildOutput(Buffer.alloc(0), { contract: oemContract(936), platform: WIN })
    expect(oem.meta.encoding).toBe('gbk')
    expect(oem.meta.source).toBe('contract')
  })

  it('MINOR：一次性解码暴露 weakEvidence，调用点才能落地 §8.5', () => {
    const weak = decodeChildOutput(Buffer.from(UTF16BE_PURE_CJK_SHORT_HEX, 'hex'), {
      contract: AUTO_CONTRACT,
      oemCodepage: 936,
      platform: WIN
    })
    expect(weak.weakEvidence).toBe(true)

    const strong = decodeChildOutput(Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex'), { contract: oemContract(936), platform: WIN })
    expect(strong.weakEvidence).toBe(false)
  })
})

describe('createChildStreamDecoder fallback meta', () => {
  it('MINOR：所有候选解码器都失败时按可逆兜底标记 fallback-latin1/low（不再误标 utf16-structure）', () => {
    // CP437 没有内置解码器（oemLabel=undefined），候选只剩 utf-8 / utf-16le；
    // 这组字节在两者下都非法（孤住高位代理项），且无零字节偶模信号。
    const decoder = createChildStreamDecoder({ contract: oemContract(437) })
    decoder.write(Buffer.from([0x41, 0xd8, 0xd8, 0x41]))
    expect(decoder.meta.encoding).toBe('windows-1252')
    expect(decoder.meta.source).toBe('fallback-latin1')
    expect(decoder.meta.confidence).toBe('low')
  })
})

describe('createChildStreamDecoder', () => {
  it('T2 任意切分（1/3/7/64 字节）与整块解码逐字符一致', () => {
    const expected = decodeChildOutput(ACCIDENT_BYTES, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(expected.text).toBe(ACCIDENT_TEXT)
    for (const size of [1, 3, 7, 64, 136, 4096]) {
      const result = streamAll(split(ACCIDENT_BYTES, size), { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
      expect(result.text, `chunkSize=${size}`).toBe(expected.text)
      expect(result.meta, `chunkSize=${size}`).toEqual(expected.meta)
    }
  })

  it('M5：无 BOM 纯 CJK UTF-16LE 分块喂入仍锁定 utf-16le（结构仲裁 + 可疑）', () => {
    const buf = Buffer.from(UTF16LE_PURE_CJK_HEX, 'hex')
    for (const size of [7, 24]) {
      const decoder = createChildStreamDecoder({ contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
      let text = ''
      for (const chunk of split(buf, size)) text += decoder.write(chunk)
      text += decoder.end()
      expect(text, 'chunkSize=' + size).toBe('中文测试数据中文测试数据')
      expect(decoder.meta.encoding, 'chunkSize=' + size).toBe('utf-16le')
      expect(decoder.meta.source, 'chunkSize=' + size).toBe('utf16-structure')
      expect(decoder.weakEvidence, 'chunkSize=' + size).toBe(true)
    }
  })

  it('纯 ASCII 前缀立即交付，不因判定而延迟', () => {
    const decoder = createChildStreamDecoder({ contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(decoder.write(Buffer.from('hello world'))).toBe('hello world')
    expect(decoder.locked).toBe(false)
    expect(decoder.bufferedBytes).toBe(11)
    expect(decoder.end()).toBe('')
    expect(decoder.meta.encoding).toBe('utf-8')
  })

  it('rawBytes 永远是原始字节数，与文本长度无关', () => {
    const decoder = createChildStreamDecoder({ contract: oemContract(936), platform: WIN })
    const buf = Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex')
    decoder.write(buf)
    decoder.end()
    expect(decoder.rawBytes).toBe(8)
    expect(decoder.meta.encoding).toBe('gbk')
  })

  it('T11 编码翻转诱饵：ASCII 前缀已交付后仍按整块结论锁定，不改判', () => {
    const sample = Buffer.concat([Buffer.from('abcdefgh', 'utf8'), Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex')])
    const options = { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN } as const
    const streamed = streamAll(split(sample, 4), options)
    const whole = decodeChildOutput(sample, options)
    expect(streamed.text).toBe(whole.text)
    expect(streamed.text).toBe('abcdefgh中文测试')
    expect(streamed.meta.encoding).toBe('gbk')
  })

  it('T8 越窗后契约冲突：保持已锁定编码、标记可疑、不静默重解', () => {
    const decoder = createChildStreamDecoder({ contract: UTF8_CONTRACT, oemCodepage: 936, platform: WIN, windowBytes: 16 })
    const head = Buffer.from('abcdefghijklmnop', 'utf8')
    const rest = Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex')
    let text = ''
    text += decoder.write(head)
    expect(decoder.locked).toBe(true)
    expect(decoder.meta.encoding).toBe('utf-8')
    expect(decoder.meta.source).toBe('contract')
    text += decoder.write(rest)
    text += decoder.end()
    expect(decoder.meta.encoding).toBe('utf-8')
    expect(text.includes('\uFFFD')).toBe(true)
    expect(decoder.weakEvidence).toBe(false)
  })
  it('守卫：已交付 ASCII 前缀与后续 UTF-16 解释冲突时退回可逆兜底并标记可疑', () => {
    const decoder = createChildStreamDecoder({ contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(decoder.write(Buffer.from('ab', 'utf8'))).toBe('ab')
    let text = decoder.write(ACCIDENT_BYTES)
    text += decoder.end()
    expect(decoder.meta.source).toBe('fallback-latin1')
    expect(decoder.meta.confidence).toBe('low')
    expect(decoder.weakEvidence).toBe(true)
    // 兜底补偿：已交付前缀必须原样保留，且分歧点之后的兜底文本要补上（不静默丢字节）。
    expect(text).toBe(new TextDecoder('windows-1252').decode(Buffer.concat([Buffer.from('ab', 'utf8'), ACCIDENT_BYTES])).slice(2))
  })

  it('MINOR：兜底锁定后交付文本必须覆盖整段字节（不静默留空洞）', () => {
    // 固定输入：三个候选解码器（utf-8 / gbk / utf-16le）全部失败，只能退到可逆兜底。
    const bytes = Buffer.from('20d80040004000000000004080', 'hex')
    const decoder = createChildStreamDecoder({ contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN, windowBytes: 3 })
    let text = ''
    for (const chunk of split(bytes, 5)) text += decoder.write(chunk)
    text += decoder.end()
    expect(decoder.meta.source).toBe('fallback-latin1')
    expect(decoder.meta.confidence).toBe('low')
    // 兜底路径交付的必须是整段字节的可逆解码结果，不能中间缺一段。
    expect(text).toBe(new TextDecoder('windows-1252').decode(bytes))
  })

  it('windowBytes=0 退化为「首块即判定」，且锁定后不再改判', () => {
    const decoder = createChildStreamDecoder({ contract: oemContract(936), platform: WIN, windowBytes: 0 })
    const buf = Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex')
    decoder.write(buf)
    decoder.end()
    expect(decoder.locked).toBe(true)
    expect(decoder.meta.encoding).toBe('gbk')
  })
})
