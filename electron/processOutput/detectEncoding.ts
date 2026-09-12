import { TextDecoder } from 'util'
import type { DecodedStreamMeta, OutputEncodingContract } from '../../src/shared/outputEncoding'
import { expectedLabelForContract, labelForOemCodepage, resolveOemCodepage } from './contracts'

export interface DetectEncodingOptions {
  contract: OutputEncodingContract
  platform?: NodeJS.Platform
  /** 显式指定 OEM 代码页（测试与「已知宿主」场景）；缺省走注册表探测 */
  oemCodepage?: number
}

export interface DetectEncodingResult {
  meta: DecodedStreamMeta
  /** 弱证据：样本不足以给出可靠结论，上层必须标记 decodeSuspect */
  weakEvidence: boolean
}

/** 可逆兜底编码：256 字节全映射，任何字节都能原样还原。 */
export const FALLBACK_ENCODING_LABEL = 'windows-1252'

const STRUCTURE_MIN_BYTES = 16
const STRUCTURE_SCORE_FLOOR = 0.5
const STRUCTURE_SCORE_MARGIN = 0.1
const CONTROL_RATIO_LIMIT = 0.05
const UTF16_ZERO_PARITY_HIGH_RATIO = 0.5
const UTF16_ZERO_PARITY_LOW_RATIO = 0.1

const COMMON_UNIT_RE = /[\t\n\r\u0020-\u007E\u00A0-\u00FF\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/
const NEGATIVE_UNIT_RE = /[\uE000-\uF8FF\uF900-\uFAFF\uFFFD]/

/**
 * 严格解码：用 `{stream:true}` 容忍「快照尾部的不完整多字节序列」（快照可能是流的前缀而非结尾），
 * 但真正的非法字节仍然抛错——这是取代现状「含 U+FFFD 即回退 GBK」判据的基础。
 */
export function decodeStrictTolerant(label: string, buf: Buffer): string | undefined {
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf, { stream: true })
  } catch {
    return undefined
  }
}

/** 非严格解码：尾部不完整序列按 U+FFFD 落地（用于打分与最终文本投影）。 */
export function decodeWithLabel(label: string, buf: Buffer): string {
  if (buf.length === 0) return ''
  return new TextDecoder(label).decode(buf)
}

/**
 * 「这份字节能按严格 UTF-8 解释」的判据。
 * 一次都没解出字符（整个样本还压在解码器的多字节缓冲区里）不算通过：那只说明样本太短。
 */
export function isStrictUtf8Valid(buf: Buffer): boolean {
  const decoded = decodeStrictTolerant('utf-8', buf)
  if (decoded === undefined) return false
  return buf.length === 0 || decoded.length > 0
}

export function countReplacements(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0xfffd) count += 1
  }
  return count
}

/** NUL 字符计数：真实文本不会包含 U+0000，命中即为编码判错的强信号（事故中 50 个 NUL）。 */
export function countNulChars(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x00) count += 1
  }
  return count
}

export function countNegativeUnits(text: string): number {
  let count = 0
  for (const unit of text) if (NEGATIVE_UNIT_RE.test(unit)) count += 1
  return count
}

/** 常见文本区占比 − 负分区占比（§8.1 判据 3）。 */
export function textScore(text: string): number {
  const units = [...text]
  if (units.length === 0) return 0
  let common = 0
  let negative = 0
  for (const unit of units) {
    if (NEGATIVE_UNIT_RE.test(unit)) negative += 1
    else if (COMMON_UNIT_RE.test(unit)) common += 1
  }
  return (common - negative) / units.length
}

function controlRatio(text: string): number {
  const units = [...text]
  if (units.length === 0) return 0
  let control = 0
  for (const unit of units) {
    const code = unit.codePointAt(0) ?? 0
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control += 1
  }
  return control / units.length
}

export function hasNonAscii(buf: Buffer): boolean {
  for (const byte of buf) if (byte >= 0x80) return true
  return false
}

/** 纯 ASCII 文本（含制表/换行）：所有 ASCII 兼容编码在此一致，可立即交付。 */
export function isAsciiText(buf: Buffer): boolean {
  for (const byte of buf) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    if (byte < 0x20 || byte > 0x7e) return false
  }
  return true
}

function readBom(buf: Buffer): { label: string; bytes: number } | undefined {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { label: 'utf-8', bytes: 3 }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { label: 'utf-16le', bytes: 2 }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { label: 'utf-16be', bytes: 2 }
  return undefined
}

/**
 * UTF-16 零字节奇偶模式（§8.1 判据 2）。
 * 阈值按事故样本校准：136 字节样本的 0x00 全部落在奇数下标，占该奇偶位的 73.5%
 * （需求原文的 80% 对同一份样本不成立，见 docs/develop 实施记录）。
 */
export function detectUtf16ZeroParity(buf: Buffer): 'le' | 'be' | undefined {
  if (buf.length < STRUCTURE_MIN_BYTES || buf.length % 2 !== 0) return undefined
  const units = buf.length / 2
  let evenZero = 0
  let oddZero = 0
  for (let index = 0; index < buf.length; index += 2) {
    if (buf[index] === 0) evenZero += 1
    if (buf[index + 1] === 0) oddZero += 1
  }
  const evenRatio = evenZero / units
  const oddRatio = oddZero / units
  if (oddRatio >= UTF16_ZERO_PARITY_HIGH_RATIO && evenRatio <= UTF16_ZERO_PARITY_LOW_RATIO) return 'le'
  if (evenRatio >= UTF16_ZERO_PARITY_HIGH_RATIO && oddRatio <= UTF16_ZERO_PARITY_LOW_RATIO) return 'be'
  return undefined
}

/**
 * UTF-16 结构启发式（§8.1 判据 5）：仅在契约未给出、或契约 fatal 校验失败时参与。
 * `oemText` 用非严格解码：尾部坏字节应作为 U+FFFD 计入负分，否则 OEM 解释会被高估。
 */
export function tryUtf16Structure(sample: Buffer, oemText: string | undefined): 'utf-16le' | 'utf-16be' | undefined {
  if (sample.length < STRUCTURE_MIN_BYTES || sample.length % 2 !== 0) return undefined
  const oemScore = oemText === undefined ? undefined : textScore(oemText)
  let best: { encoding: 'utf-16le' | 'utf-16be'; score: number } | undefined
  for (const encoding of ['utf-16le', 'utf-16be'] as const) {
    const text = decodeWithLabel(encoding, sample)
    if (text.length === 0) continue
    if (controlRatio(text) > CONTROL_RATIO_LIMIT) continue
    if (countNegativeUnits(text) > 0) continue
    const score = textScore(text)
    if (!best || score > best.score) best = { encoding, score }
  }
  if (!best || best.score < STRUCTURE_SCORE_FLOOR) return undefined
  if (oemScore !== undefined && best.score < oemScore + STRUCTURE_SCORE_MARGIN) return undefined
  return best.encoding
}

function conflictFor(contractLabel: string | undefined, actualLabel: string): 'contract-mismatch' | undefined {
  return contractLabel !== undefined && contractLabel !== actualLabel ? 'contract-mismatch' : undefined
}

/**
 * 一次性编码判定（§8.1 判定链）。
 * 纯函数：只吃字节与契约，产出「编码事实」，不做 IO、不 spawn。
 */
export function detectEncoding(sample: Buffer, options: DetectEncodingOptions): DetectEncodingResult {
  const platform = options.platform ?? process.platform
  const oemCodepage = resolveOemCodepage(options.contract, options.oemCodepage, platform)
  const oemLabel = labelForOemCodepage(oemCodepage)
  const contractLabel = expectedLabelForContract(options.contract)
  const contractKind = options.contract.kind
  const baseMeta = { bomBytes: 0, contractKind } as const

  const bom = readBom(sample)
  if (bom) {
    return {
      meta: {
        ...baseMeta,
        encoding: bom.label,
        source: 'bom',
        confidence: 'exact',
        bomBytes: bom.bytes,
        contractConflict: conflictFor(contractLabel, bom.label)
      },
      weakEvidence: false
    }
  }

  const parity = detectUtf16ZeroParity(sample)
  if (parity) {
    const label = parity === 'le' ? 'utf-16le' : 'utf-16be'
    return {
      meta: {
        ...baseMeta,
        encoding: label,
        source: 'utf16-pattern',
        confidence: 'high',
        contractConflict: conflictFor(contractLabel, label)
      },
      weakEvidence: false
    }
  }

  let contractFailed = false
  if (options.contract.kind !== 'auto' && contractLabel !== undefined) {
    // OEM 契约的已知例外（§3.3 结论 3 / §5 S4）：native 工具自决编码，UTF-8 字节优先。
    if (options.contract.kind === 'oem' && oemLabel !== 'utf-8' && hasNonAscii(sample) && isStrictUtf8Valid(sample)) {
      return {
        meta: {
          ...baseMeta,
          encoding: 'utf-8',
          source: 'strict-utf8',
          confidence: 'high',
          codepage: oemCodepage,
          contractConflict: 'contract-mismatch'
        },
        weakEvidence: false
      }
    }
    if (decodeStrictTolerant(contractLabel, sample) !== undefined) {
      return {
        meta: {
          ...baseMeta,
          encoding: contractLabel,
          source: 'contract',
          confidence: 'high',
          codepage: oemCodepage,
          contractConflict: undefined
        },
        weakEvidence: false
      }
    }
    contractFailed = true
  }

  const conflict: 'contract-mismatch' | undefined = contractFailed ? 'contract-mismatch' : undefined

  if (isStrictUtf8Valid(sample)) {
    return {
      meta: { ...baseMeta, encoding: 'utf-8', source: 'strict-utf8', confidence: 'high', codepage: oemCodepage, contractConflict: conflict },
      weakEvidence: false
    }
  }

  const oemStrictOk = oemLabel !== undefined && decodeStrictTolerant(oemLabel, sample) !== undefined
  const oemSampleText = oemLabel === undefined ? undefined : decodeWithLabel(oemLabel, sample)
  const structure = tryUtf16Structure(sample, oemSampleText)
  if (structure) {
    return {
      meta: { ...baseMeta, encoding: structure, source: 'utf16-structure', confidence: 'medium', codepage: oemCodepage, contractConflict: conflict },
      weakEvidence: false
    }
  }
  const structureInconclusive = sample.length < STRUCTURE_MIN_BYTES || sample.length % 2 !== 0

  if (oemLabel !== undefined && oemStrictOk) {
    return {
      meta: { ...baseMeta, encoding: oemLabel, source: 'oem-codepage', confidence: 'high', codepage: oemCodepage, contractConflict: conflict },
      weakEvidence: structureInconclusive
    }
  }

  return {
    meta: {
      ...baseMeta,
      encoding: FALLBACK_ENCODING_LABEL,
      source: 'fallback-latin1',
      confidence: 'low',
      codepage: oemCodepage,
      contractConflict: conflict
    },
    weakEvidence: true
  }
}

/** decodeSuspect 的唯一定义（§8.4）：低置信、结构不判定、U+FFFD、NUL、或 medium 且契约冲突。 */
export function isDecodeSuspect(
  meta: DecodedStreamMeta,
  extra: { replacements?: number; weakEvidence?: boolean; nulChars?: number } = {}
): boolean {
  if (meta.confidence === 'low') return true
  if (extra.weakEvidence) return true
  if ((extra.replacements ?? 0) > 0) return true
  if ((extra.nulChars ?? 0) > 0) return true
  if (meta.confidence === 'medium' && meta.contractConflict) return true
  return false
}
