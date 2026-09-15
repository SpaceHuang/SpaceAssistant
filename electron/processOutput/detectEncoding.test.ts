import { describe, expect, it } from 'vitest'
import { TextDecoder } from 'util'
import { AUTO_CONTRACT, UTF16LE_CONTRACT, UTF8_CONTRACT, labelForOemCodepage, oemContract } from './contracts'
import { decodeChildOutput, createChildStreamDecoder } from './decodeChildOutput'
import { detectEncoding, isDecodeSuspect, textScore } from './detectEncoding'
import {
  ACCIDENT_BYTES,
  ACCIDENT_TEXT,
  GBK_ZH_LONG_HEX,
  GBK_ZH_TEST_BARE_HEX,
  GBK_ZH_TEST_HEX,
  UTF16BE_BOM_HEX,
  UTF16BE_PURE_CJK_HEX,
  UTF16BE_PURE_CJK_SHORT_HEX,
  UTF16LE_PURE_CJK_HEX,
  UTF8_ZH_TEST_BOM_HEX,
  UTF8_ZH_TEST_HEX
} from './testFixtures'

const WIN = 'win32' as NodeJS.Platform

/** 事故中的现状解码规则（附录 A.3），仅用于证明回归确实被消除。 */
function legacyDecodeProcessOutput(buf: Buffer, platform: NodeJS.Platform = WIN): string {
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (platform !== 'win32') return utf8
  const gbk = new TextDecoder('gbk').decode(buf)
  const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s)
  if (hasCjk(gbk) && !hasCjk(utf8)) return gbk
  if (utf8.includes('\uFFFD') && hasCjk(gbk)) return gbk
  return utf8
}

describe('detectEncoding 判定链', () => {
  it('T1 事故真实样本：136 字节 UTF-16LE 由零字节奇偶模式判定', () => {
    const result = decodeChildOutput(ACCIDENT_BYTES, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.meta.encoding).toBe('utf-16le')
    expect(result.meta.source).toBe('utf16-pattern')
    expect(result.meta.confidence).toBe('high')
    expect(result.meta.bomBytes).toBe(0)
    expect(result.text).toBe(ACCIDENT_TEXT)
    expect(result.replacements).toBe(0)
    expect(isDecodeSuspect(result.meta, { replacements: result.replacements })).toBe(false)
  })

  it('T1 回归对照：现状启发式把同一份字节解成 GBK 乱码（含 NUL）', () => {
    const legacy = legacyDecodeProcessOutput(ACCIDENT_BYTES)
    expect(legacy).not.toBe(ACCIDENT_TEXT)
    expect(legacy.includes('\u0000')).toBe(true)
    expect(Buffer.byteLength(legacy, 'utf8')).toBe(154)
  })

  it('T3 无 prelude 的 PS 输出按 OEM CP 936 解出「中文测试」', () => {
    const buf = Buffer.from(GBK_ZH_TEST_HEX, 'hex')
    const result = decodeChildOutput(buf, { contract: oemContract(936), platform: WIN })
    expect(result.text).toBe('中文测试\r\n')
    expect(result.meta.encoding).toBe('gbk')
    expect(result.replacements).toBe(0)
    expect(isDecodeSuspect(result.meta, { replacements: result.replacements })).toBe(false)
  })

  it('T4 UTF-8 带/不带 BOM 都解为「中文测试」且 BOM 被记录', () => {
    const plain = decodeChildOutput(Buffer.from(UTF8_ZH_TEST_HEX, 'hex'), { contract: UTF8_CONTRACT, platform: WIN })
    expect(plain.text).toBe('中文测试\r\n')
    expect(plain.meta.encoding).toBe('utf-8')
    expect(plain.meta.source).toBe('contract')
    expect(plain.meta.bomBytes).toBe(0)

    const bom = decodeChildOutput(Buffer.from(UTF8_ZH_TEST_BOM_HEX, 'hex'), { contract: AUTO_CONTRACT, platform: WIN })
    expect(bom.text).toBe('中文测试\r\n')
    expect(bom.meta.encoding).toBe('utf-8')
    expect(bom.meta.source).toBe('bom')
    expect(bom.meta.confidence).toBe('exact')
    expect(bom.meta.bomBytes).toBe(3)
  })

  it('T5a UTF-16BE 带 BOM：exact / bomBytes=2', () => {
    const result = decodeChildOutput(Buffer.from(UTF16BE_BOM_HEX, 'hex'), { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.meta.encoding).toBe('utf-16be')
    expect(result.meta.source).toBe('bom')
    expect(result.meta.confidence).toBe('exact')
    expect(result.meta.bomBytes).toBe(2)
    expect(result.text).toBe('中文中文中文中文中文')
  })

  it('T5b 无 BOM 纯 CJK UTF-16BE：结构启发式判定为 medium', () => {
    const buf = Buffer.from(UTF16BE_PURE_CJK_HEX, 'hex')
    expect(buf.length).toBe(20)
    const result = decodeChildOutput(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.meta.encoding).toBe('utf-16be')
    expect(result.meta.source).toBe('utf16-structure')
    expect(result.meta.confidence).toBe('medium')
    expect(result.text).toBe('中文中文中文中文中文')
    expect(isDecodeSuspect(result.meta, { replacements: result.replacements })).toBe(false)
  })

  it('T5c 无 BOM 纯 CJK 但样本 <16 字节：不猜，标记可疑并保留原始字节', () => {
    const buf = Buffer.from(UTF16BE_PURE_CJK_SHORT_HEX, 'hex')
    expect(buf.length).toBe(12)
    const { meta, weakEvidence } = detectEncoding(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(meta.source).not.toBe('utf16-structure')
    expect(meta.encoding).toBe('gbk')
    expect(isDecodeSuspect(meta, { weakEvidence })).toBe(true)
  })

  it('T5d 无 BOM 纯 CJK UTF-16LE：GBK 解释同分，靠字节层高字节对齐仲裁为 utf-16le（M5）', () => {
    const buf = Buffer.from(UTF16LE_PURE_CJK_HEX, 'hex')
    expect(buf.length).toBe(24)
    // 前提复现：GBK 解释产出「ASCII+CJK 交替」伪文本（-N噀Km諎penc…），文本分与 UTF-16 解释并列
    expect(textScore(new TextDecoder('gbk').decode(buf))).toBe(1)

    const result = decodeChildOutput(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.text).toBe('中文测试数据中文测试数据')
    expect(result.meta.encoding).toBe('utf-16le')
    expect(result.meta.source).toBe('utf16-structure')
    expect(result.meta.confidence).toBe('medium')

    // 并列仲裁是弱证据：必须标可疑（留原始字节），不能静默当成可信输出交付
    const detect = detectEncoding(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(detect.weakEvidence).toBe(true)
    expect(isDecodeSuspect(detect.meta, { weakEvidence: detect.weakEvidence })).toBe(true)
  })

  it('T5e OEM CP936 契约下的 LE 纯 CJK：契约严格解码不掩盖 UTF-16 结构证据（M5）', () => {
    const buf = Buffer.from(UTF16LE_PURE_CJK_HEX, 'hex')
    const result = decodeChildOutput(buf, { contract: oemContract(936), oemCodepage: 936, platform: WIN })
    expect(result.text).toBe('中文测试数据中文测试数据')
    expect(result.meta.encoding).toBe('utf-16le')
    expect(result.meta.source).toBe('utf16-structure')
    expect(result.meta.confidence).toBe('medium')
    expect(result.meta.contractConflict).toBe('contract-mismatch')
  })

  it('T5f 真实 GBK 长样本不被结构仲裁误翻（负分单元 + 对齐不成立）', () => {
    const buf = Buffer.from(GBK_ZH_LONG_HEX, 'hex')
    expect(buf.length).toBe(24)
    const result = decodeChildOutput(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.text).toBe('中文测试数据中文测试数据')
    expect(result.meta.encoding).toBe('gbk')
    expect(result.meta.source).toBe('oem-codepage')
    expect(result.meta.confidence).toBe('high')
    expect(isDecodeSuspect(result.meta, { replacements: result.replacements })).toBe(false)
  })

  it('T5g 数据本身歧义（GBK/3 生僻字）：保留 OEM 解释，但绝不静默交付', () => {
    // 81 40 既可读作 GBK「丂」也可读作 UTF-16BE「腀」，两种读法都是通顺的纯 CJK，
    // 字节层没有能区分二者的证据：此时不覆盖 OEM 解释，但必须降级为可疑。
    const buf = Buffer.from('8140'.repeat(10), 'hex')
    expect(buf.length).toBe(20)
    const detect = detectEncoding(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(detect.meta.encoding).toBe('gbk')
    expect(detect.meta.source).toBe('oem-codepage')
    expect(detect.weakEvidence).toBe(true)
    expect(isDecodeSuspect(detect.meta, { weakEvidence: detect.weakEvidence })).toBe(true)
  })

  it('T6 非 GBK 的 OEM CP：Big5 / Shift_JIS 解对，CP437 走可逆兜底', () => {
    const big5 = decodeChildOutput(Buffer.from('a4a4a4e5', 'hex'), { contract: oemContract(950), platform: WIN })
    expect(big5.meta.encoding).toBe('big5')
    expect(big5.text).toBe('中文')

    const sjis = decodeChildOutput(Buffer.from('93fa967b8cea', 'hex'), { contract: oemContract(932), platform: WIN })
    expect(sjis.meta.encoding).toBe('shift_jis')
    expect(sjis.text).toBe('日本語')

    const cp437 = decodeChildOutput(Buffer.from('808182', 'hex'), { contract: oemContract(437), platform: WIN })
    expect(cp437.meta.source).toBe('fallback-latin1')
    expect(cp437.meta.confidence).toBe('low')
    expect(cp437.meta.encoding).toBe('windows-1252')
    expect(isDecodeSuspect(cp437.meta)).toBe(true)
  })

  it('T7 合法文本含 U+FFFD 时保持 UTF-8，不退化为 GBK', () => {
    const buf = Buffer.concat([Buffer.from('efbfbd', 'hex'), Buffer.from('hello', 'utf8')])
    const result = decodeChildOutput(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.meta.encoding).toBe('utf-8')
    expect(result.meta.source).toBe('strict-utf8')
    expect(result.text).toBe('\uFFFDhello')
    expect(result.text).not.toContain('锟')
  })

  it('T8 契约与强证据冲突：改为探测结论并记录 contract-mismatch', () => {
    const result = decodeChildOutput(ACCIDENT_BYTES, { contract: UTF8_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.meta.encoding).toBe('utf-16le')
    expect(result.meta.contractConflict).toBe('contract-mismatch')
    expect(result.text).toBe(ACCIDENT_TEXT)
  })

  it('OEM 契约遇到 native 工具自决的 UTF-8 字节时优先 UTF-8 并记录冲突', () => {
    const result = decodeChildOutput(Buffer.from(UTF8_ZH_TEST_HEX, 'hex'), { contract: oemContract(936), platform: WIN })
    expect(result.meta.encoding).toBe('utf-8')
    expect(result.meta.source).toBe('strict-utf8')
    expect(result.meta.contractConflict).toBe('contract-mismatch')
    expect(result.text).toBe('中文测试\r\n')
    // 契约冲突不构成「可疑」：high 置信度下 §8.4 不强制 suspect
    expect(isDecodeSuspect(result.meta, { replacements: result.replacements })).toBe(false)
  })

  it('BOM 与契约冲突同样记录 contract-mismatch', () => {
    const result = decodeChildOutput(Buffer.from(UTF8_ZH_TEST_BOM_HEX, 'hex'), { contract: UTF16LE_CONTRACT, platform: WIN })
    expect(result.meta.source).toBe('bom')
    expect(result.meta.encoding).toBe('utf-8')
    expect(result.meta.contractConflict).toBe('contract-mismatch')
  })

  it('T9 同一流内混合 UTF-16LE ASCII 与 GBK：不抛错、字节不丢、标记可疑', () => {
    const buf = Buffer.concat([Buffer.from('610062006300', 'hex'), Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex')])
    expect(buf.length).toBe(14)
    const result = decodeChildOutput(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(result.replacements).toBe(0)
    expect(result.text).toContain('\u0000')
    expect(isDecodeSuspect(result.meta, { replacements: result.replacements, nulChars: (result.text.match(/\u0000/g) ?? []).length })).toBe(true)
  })

  it('T10 多字节字符跨 chunk：UTF-8 三字节 1+1+1、GBK 双字节 1+1 都不产生 U+FFFD', () => {
    const utf8 = createChildStreamDecoder({ contract: UTF8_CONTRACT, platform: WIN, windowBytes: 0 })
    const utf8Bytes = Buffer.from('e4b8ad', 'hex')
    let utf8Text = ''
    for (const byte of utf8Bytes) utf8Text += utf8.write(Buffer.from([byte]))
    utf8Text += utf8.end()
    expect(utf8Text).toBe('中')

    const gbk = createChildStreamDecoder({ contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN, windowBytes: 0 })
    const gbkBytes = Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex')
    let gbkText = ''
    for (const byte of gbkBytes) gbkText += gbk.write(Buffer.from([byte]))
    gbkText += gbk.end()
    expect(gbkText).toBe('中文测试')
    expect(gbkText).not.toContain('\uFFFD')
  })

  it('未知 OEM 代码页标签映射为 undefined（437/850 无内置解码器）', () => {
    expect(labelForOemCodepage(936)).toBe('gbk')
    expect(labelForOemCodepage(437)).toBeUndefined()
    expect(labelForOemCodepage(850)).toBeUndefined()
    expect(labelForOemCodepage(undefined)).toBeUndefined()
  })
})
