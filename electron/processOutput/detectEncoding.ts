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
/** CJK 码元高字节区间（U+4E00–U+9FFF 的高字节），用于并列仲裁的字节层证据。 */
const CJK_HIGH_BYTE_MIN = 0x4e
const CJK_HIGH_BYTE_MAX = 0x9f
const CJK_HIGH_BYTE_ALIGN_RATIO = 0.9
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

export type Utf16StructureVerdict =
  /** 文本分明显优于 OEM 解释：直接采用结构解释（medium）。 */
  | 'strong'
  /**
   * 文本分与 OEM 解释并列，但字节层对齐成立、且 OEM 解释呈「ASCII/CJK 交替」伪文本特征
   * （GBK 错解 UTF-16LE 纯 CJK 的签名）：采用结构解释，但必须按弱证据标可疑。
   */
  | 'override'
  /**
   * 文本分并列、字节层对齐也成立，但两种读法都是通顺的纯 CJK（数据本身歧义，例如
   * GBK/3 生僻字）：保留 OEM/契约解释，同时标可疑，绝不当成可信输出交付。
   */
  | 'ambiguous'

export interface Utf16StructureResult {
  encoding: 'utf-16le' | 'utf-16be'
  verdict: Utf16StructureVerdict
}

/** 「ASCII 与 CJK 混排」：GBK 错解 UTF-16LE 纯 CJK 时特有的伪文本签名。 */
function mixesAsciiAndCjk(text: string): boolean {
  return /[一-鿿]/.test(text) && /[ -~]/.test(text)
}

/**
 * CJK 高字节对齐（§8.1 判据 5 的补充证据，只用于「文本分并列」的仲裁）。
 *
 * 纯 CJK 的 UTF-16 流里，码元高字节（LE 在奇数位、BE 在偶数位）必然落在
 * U+4E00–U+9FFF 的高字节区间 [0x4E,0x9F]；而同一批字节按 GBK 等 CJK 多字节编码
 * 解释时，这些位置是 trail byte（0x40–0xFE），命中该区间的比例接近随机。
 * 实测（24 字节样本）：LE 纯 CJK 为 1.00，真实 GBK「中文测试数据」×2 为 0.00。
 */
function hasCjkHighByteAlignment(buf: Buffer, encoding: 'utf-16le' | 'utf-16be'): boolean {
  const units = Math.floor(buf.length / 2)
  if (units * 2 < STRUCTURE_MIN_BYTES) return false
  const offset = encoding === 'utf-16le' ? 1 : 0
  let aligned = 0
  for (let index = 0; index < units; index += 1) {
    const high = buf[index * 2 + offset]
    if (high !== undefined && high >= CJK_HIGH_BYTE_MIN && high <= CJK_HIGH_BYTE_MAX) aligned += 1
  }
  return aligned / units >= CJK_HIGH_BYTE_ALIGN_RATIO
}

/**
 * UTF-16 结构启发式（§8.1 判据 5）：仅在契约未给出、或契约 fatal 校验失败时参与。
 * oemText 用非严格解码：尾部坏字节应作为 U+FFFD 计入负分，否则 OEM 解释会被高估。
 */
export function tryUtf16Structure(sample: Buffer, oemText: string | undefined): Utf16StructureResult | undefined {
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
  if (oemScore !== undefined && best.score < oemScore + STRUCTURE_SCORE_MARGIN) {
    // 并列仲裁（M5）：无 BOM 纯 CJK 的 UTF-16LE 流被 GBK 解释成「ASCII+CJK 交替」伪文本时，
    // 两种解释的文本分完全并列（OEM 侧 1.0），margin 判据会永远否决结构启发式，
    // 于是貌似可读的乱码被当成可信输出交付。此时改用字节层证据仲裁：只有高字节对齐成立
    // 才让结构启发式优先，并按并列语义降级为弱证据（suspect + 原始字节留档）。
    // 纯 ASCII 样本不存在歧义（ASCII 与所有 ASCII 兼容编码一致），不进入并列仲裁。
    if (!hasNonAscii(sample)) return undefined
    if (best.score < oemScore || !hasCjkHighByteAlignment(sample, best.encoding)) return undefined
    // OEM 解释是「ASCII+CJK 交替」的伪文本 → 结构解释才是真值；否则两种读法都通顺，保留 OEM 解释只标可疑。
    const verdict: Utf16StructureVerdict = oemText !== undefined && mixesAsciiAndCjk(oemText) ? 'override' : 'ambiguous'
    return { encoding: best.encoding, verdict }
  }
  return { encoding: best.encoding, verdict: 'strong' }
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

  const oemStrictOk = oemLabel !== undefined && decodeStrictTolerant(oemLabel, sample) !== undefined
  const oemSampleText = oemLabel === undefined ? undefined : decodeWithLabel(oemLabel, sample)
  const structure = tryUtf16Structure(sample, oemSampleText)
  const structureOverridesOem = structure?.verdict === 'override'
  const structureAmbiguous = structure?.verdict === 'ambiguous'

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
    const contractStrictOk = decodeStrictTolerant(contractLabel, sample) !== undefined
    // 契约严格解码成功才默认优先；但并列仲裁（verdict=override）说明字节层有更强的
    // UTF-16 证据，此时不能让契约掩盖它，继续往下走结构启发式（M5）；
    // verdict=ambiguous 则保留契约解释，只把结果降级为可疑。
    if (contractStrictOk && !structureOverridesOem) {
      return {
        meta: {
          ...baseMeta,
          encoding: contractLabel,
          source: 'contract',
          confidence: 'high',
          codepage: oemCodepage,
          contractConflict: undefined
        },
        weakEvidence: structureAmbiguous
      }
    }
    contractFailed = !contractStrictOk
  }

  const conflict: 'contract-mismatch' | undefined = contractFailed ? 'contract-mismatch' : undefined

  if (isStrictUtf8Valid(sample)) {
    return {
      meta: { ...baseMeta, encoding: 'utf-8', source: 'strict-utf8', confidence: 'high', codepage: oemCodepage, contractConflict: conflict },
      weakEvidence: false
    }
  }

  if (structure && !structureAmbiguous) {
    return {
      meta: {
        ...baseMeta,
        encoding: structure.encoding,
        source: 'utf16-structure',
        confidence: 'medium',
        codepage: oemCodepage,
        contractConflict: conflictFor(contractLabel, structure.encoding)
      },
      weakEvidence: structureOverridesOem
    }
  }
  const structureInconclusive = sample.length < STRUCTURE_MIN_BYTES || sample.length % 2 !== 0

  if (oemLabel !== undefined && oemStrictOk) {
    return {
      meta: { ...baseMeta, encoding: oemLabel, source: 'oem-codepage', confidence: 'high', codepage: oemCodepage, contractConflict: conflict },
      weakEvidence: structureInconclusive || structureAmbiguous
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
